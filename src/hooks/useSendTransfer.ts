import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useConfig, useWriteContract } from 'wagmi'
import type { Address } from 'viem'
import { NETWORK } from '@/config/network'
import { usdcAbi } from '@/abi/usdc'
import { classifyTxError, describeReadError } from '@/lib/errors'
import { PrepareTimeoutError, decidePrepared, needsRefresh, type FreshInputs } from '@/lib/prepare'
import { markSend, reportSend } from '@/lib/sendTiming'
import type { FeeQuote } from '@/lib/fees'
import { initialSendState, sendReducer } from '@/lib/sendFlow'
import { localTxStore } from '@/lib/txStore'
import { useLocalTxs } from '@/hooks/useLocalTxs'

const SLOW_AFTER_MS = 45_000

export interface SubmitParams {
  from: Address
  to: Address
  amountRaw: bigint
  /** The quote shown on the review screen. */
  quote: FeeQuote
  /** When the balances shown were last read (ms). Used to decide whether they are fresh enough to authorize the send. */
  balancesUpdatedAt: number
  /** Re-reads fee and balances in parallel. Only called when the shown data is older than the freshness limits. */
  refresh: () => Promise<FreshInputs>
  /** Receives re-read data so the rest of the app shows the same numbers. */
  onFresh?: (fresh: FreshInputs) => void
}

/**
 * Runs one USDC transfer. The wallet signs and broadcasts; we never retry a submission.
 * The final state comes only from the on-chain receipt recorded by the receipt watcher.
 *
 * Between Confirm and the wallet request there is no network wait when the fee quote and balances are
 * fresh. If they are stale they are re-read in parallel (with a deadline) and re-validated first.
 */
export function useSendTransfer() {
  const [state, dispatch] = useReducer(sendReducer, initialSendState)
  const [from, setFrom] = useState<Address | undefined>()
  const lock = useRef(false)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  const config = useConfig()
  const { writeContractAsync } = useWriteContract()
  const locals = useLocalTxs(from)

  const submit = useCallback(
    async (params: SubmitParams) => {
      // One prompt per review: ignore clicks while preparing, while the wallet is open or while in flight.
      if (lock.current || stateRef.current.step !== 'review') return
      lock.current = true
      markSend('click')
      setFrom(params.from)

      try {
        let quote = params.quote
        if (needsRefresh({ quoteCreatedAt: quote.createdAt, balancesUpdatedAt: params.balancesUpdatedAt, now: Date.now() })) {
          dispatch({ type: 'prepare' })
          markSend('refresh-start')
          let fresh: FreshInputs
          try {
            fresh = await params.refresh()
          } catch (error) {
            const timedOut = error instanceof PrepareTimeoutError
            dispatch({
              type: 'error',
              message: timedOut
                ? 'The Arc RPC was too slow to confirm your latest fee and balance. Nothing was sent. Try again.'
                : `${describeReadError(error)} Could not refresh your fee and balance. Nothing was sent.`,
              definitelyNotSent: true,
            })
            return
          }
          markSend('refresh-done')
          params.onFresh?.(fresh)
          const decision = decidePrepared(fresh, { amountRaw: params.amountRaw, shownMaxFeeNative: params.quote.maxFeeNative })
          if (!decision.ok) {
            dispatch({ type: 'error', message: decision.message, definitelyNotSent: true })
            return
          }
          quote = decision.quote
          dispatch({ type: 'prepared' })
        } else {
          dispatch({ type: 'submit' })
        }

        // Checked from the wallet's own events, at the last moment before the request (no network wait).
        const current = config.state.current
        const connection = current ? config.state.connections.get(current) : undefined
        if (connection?.chainId !== NETWORK.chainId) {
          dispatch({ type: 'error', message: 'Your wallet is not on Arc Mainnet. Switch network and try again.', definitelyNotSent: true })
          return
        }
        if (connection.accounts[0]?.toLowerCase() !== params.from.toLowerCase()) {
          dispatch({ type: 'error', message: 'The selected wallet account changed. Start the transfer again. Nothing was sent.', definitelyNotSent: true })
          return
        }

        try {
          markSend('wallet-call')
          const hash = await writeContractAsync({
            address: NETWORK.usdc.address,
            abi: usdcAbi,
            functionName: 'transfer',
            args: [params.to, params.amountRaw],
            account: params.from,
            type: 'eip1559',
            gas: quote.gasLimit,
            maxFeePerGas: quote.maxFeePerGas,
            maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
          })
          markSend('wallet-answered')
          // Record the real hash immediately so it appears in Activity as pending.
          localTxStore.add({
            hash,
            from: params.from,
            to: params.to,
            amountRaw: params.amountRaw.toString(),
            createdAt: Date.now(),
            status: 'pending',
          })
          dispatch({ type: 'submitted', hash })
        } catch (error) {
          const classified = classifyTxError(error)
          if (classified.kind === 'rejected') dispatch({ type: 'rejected' })
          else dispatch({ type: 'error', message: classified.message, definitelyNotSent: classified.definitelyNotSent })
        }
      } finally {
        reportSend()
        lock.current = false
      }
    },
    [config, writeContractAsync],
  )

  // Mirror the receipt outcome recorded in the local store into the flow.
  const pendingHash = state.step === 'pending' ? state.hash : undefined
  const tracked = pendingHash ? locals.find((t) => t.hash === pendingHash) : undefined
  useEffect(() => {
    if (!tracked) return
    if (tracked.status === 'confirmed') dispatch({ type: 'confirmed', blockNumber: BigInt(tracked.blockNumber ?? '0') })
    else if (tracked.status === 'unverified') dispatch({ type: 'unverified', blockNumber: tracked.blockNumber ? BigInt(tracked.blockNumber) : undefined })
    else if (tracked.status === 'failed') dispatch({ type: 'reverted', blockNumber: tracked.blockNumber ? BigInt(tracked.blockNumber) : undefined })
  }, [tracked])

  useEffect(() => {
    if (!pendingHash) return
    const id = window.setTimeout(() => dispatch({ type: 'slow' }), SLOW_AFTER_MS)
    return () => window.clearTimeout(id)
  }, [pendingHash])

  return { state, dispatch, submit }
}
