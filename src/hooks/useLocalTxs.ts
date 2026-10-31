import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { TransactionReceiptNotFoundError, type Address } from 'viem'
import { localTxStore, type LocalTx } from '@/lib/txStore'
import { getPublicClient } from '@/lib/rpc'
import { shouldCheckReceipt, verifyTransferReceipt } from '@/lib/receipt'

const NONE: readonly LocalTx[] = []

export function useLocalTxs(address: Address | undefined): readonly LocalTx[] {
  return useSyncExternalStore(
    localTxStore.subscribe,
    () => (address ? localTxStore.get(address) : NONE),
    () => NONE,
  )
}

/**
 * Polls receipts for transactions this browser submitted and records the real outcome.
 * A missing receipt means "still pending", never "failed". Mounted once in the app shell.
 */
export function useReceiptWatcher(address: Address | undefined) {
  const queryClient = useQueryClient()
  const locals = useLocalTxs(address)
  const hasPending = locals.some((t) => t.status === 'pending')

  useEffect(() => {
    if (!address || !hasPending) return
    let stopped = false
    let running = false
    const lastChecked = new Map<string, number>()

    const tick = async () => {
      if (running) return
      running = true
      try {
        for (const tx of localTxStore.get(address)) {
          if (stopped || tx.status !== 'pending') continue
          if (!shouldCheckReceipt(tx.createdAt, lastChecked.get(tx.hash), Date.now())) continue
          lastChecked.set(tx.hash, Date.now())
          try {
            const receipt = await getPublicClient().getTransactionReceipt({ hash: tx.hash })
            // Success is only recorded when the receipt proves the exact USDC transfer we asked for.
            const verdict = verifyTransferReceipt(receipt, tx)
            localTxStore.update(address, tx.hash, {
              status: verdict === 'confirmed' ? 'confirmed' : verdict === 'reverted' ? 'failed' : 'unverified',
              blockNumber: receipt.blockNumber.toString(),
            })
            void queryClient.invalidateQueries({ queryKey: ['balances'] })
          } catch (error) {
            if (!(error instanceof TransactionReceiptNotFoundError)) {
              // RPC hiccup: keep the transaction pending and look again on the next tick.
            }
          }
        }
      } finally {
        running = false
      }
    }

    void tick()
    const id = window.setInterval(() => void tick(), 2500)
    return () => {
      stopped = true
      window.clearInterval(id)
    }
  }, [address, hasPending, queryClient])
}
