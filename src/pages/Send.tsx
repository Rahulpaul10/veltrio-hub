import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { formatUnitsExact } from '@/onchain-money'
import { NETWORK } from '@/config/network'
import { getPublicClient } from '@/lib/rpc'
import { useWallet } from '@/hooks/useWallet'
import { useBalances, useChainHealth, useFeeQuote } from '@/hooks/useChainData'
import { useSendTransfer } from '@/hooks/useSendTransfer'
import { ceilNativeToUsdc6, fetchTransferFeeQuote, maxSpendable6 } from '@/lib/fees'
import { classifyTxError, describeReadError } from '@/lib/errors'
import { formatAddress, formatUsdcAmount } from '@/lib/format'
import { refreshInputs } from '@/lib/prepare'
import { isSendBusy } from '@/lib/sendFlow'
import { normalizeAmountInput, validateTransfer } from '@/lib/validation'
import { ConnectPrompt } from '@/components/ConnectPrompt'
import { SendStatus } from '@/components/SendStatus'
import { Notice, PageTitle, Spinner } from '@/components/ui'

const fee6 = (native: bigint) => formatUsdcAmount(ceilNativeToUsdc6(native), 6)

/** A different account gets a fresh form: a recipient is never carried over silently. */
export function Send() {
  const wallet = useWallet()
  return <SendForm key={wallet.address ?? 'disconnected'} />
}

function SendForm() {
  const wallet = useWallet()
  const queryClient = useQueryClient()
  const { health, tokenVerified } = useChainHealth()
  const balances = useBalances(wallet.address)
  const flow = useSendTransfer()

  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [maxing, setMaxing] = useState(false)
  const [maxError, setMaxError] = useState<string | undefined>()

  const base = useMemo(
    () => validateTransfer({ to, amount, self: wallet.address, usdcBalance: balances.data?.usdc, nativeBalance: balances.data?.native }),
    [to, amount, wallet.address, balances.data],
  )
  // Estimate the fee only for a transfer that is otherwise valid, so estimation never runs on bad input.
  const quoteQuery = useFeeQuote({
    account: wallet.address,
    to: base.waitingFor === 'fee' ? base.recipient : undefined,
    amountRaw: base.waitingFor === 'fee' ? base.amountRaw : undefined,
  })
  const quote = quoteQuery.data
  const check = useMemo(
    () =>
      validateTransfer({
        to,
        amount,
        self: wallet.address,
        usdcBalance: balances.data?.usdc,
        nativeBalance: balances.data?.native,
        maxFeeNative: quote?.maxFeeNative,
      }),
    [to, amount, wallet.address, balances.data, quote],
  )

  if (!wallet.address) {
    return (
      <>
        <PageTitle title="Send USDC" />
        <ConnectPrompt title="Connect to send" body="Connect your wallet to send USDC on Arc Mainnet. Every transfer is confirmed in your wallet first." />
      </>
    )
  }

  const sendingDisabledReason =
    wallet.status === 'wrong-chain'
      ? 'Switch your wallet to Arc Mainnet to send.'
      : health.status === 'chain-mismatch'
        ? 'The RPC is not on Arc Mainnet.'
        : tokenVerified === false
          ? 'The configured USDC contract failed verification (expected 6-decimal USDC).'
          : undefined

  const quoteError = quoteQuery.isError
    ? classifyTxError(quoteQuery.error).kind === 'reverted'
      ? 'Arc would reject this transfer. The recipient or your address may be restricted.'
      : describeReadError(quoteQuery.error)
    : undefined

  const onMax = async () => {
    if (!wallet.address || !check.recipient || !balances.data || balances.data.usdc === 0n) return
    setMaxing(true)
    setMaxError(undefined)
    try {
      const q = await fetchTransferFeeQuote(getPublicClient(), { account: wallet.address, to: check.recipient, amountRaw: balances.data.usdc })
      // Keep a 5% margin on the worst-case fee so the final fee check still passes.
      const max = maxSpendable6(balances.data.native, (q.maxFeeNative * 105n) / 100n)
      if (max === 0n) setMaxError('Your balance is too low to cover the network fee.')
      else setAmount(formatUnitsExact(max, 6))
    } catch (error) {
      setMaxError(describeReadError(error))
    } finally {
      setMaxing(false)
    }
  }

  const summary = { to: check.recipient ?? to, amount: amount.trim() }
  const busy = isSendBusy(flow.state)

  if (flow.state.step !== 'form' && flow.state.step !== 'review') {
    return (
      <>
        <PageTitle title="Send USDC" />
        <SendStatus
          state={flow.state}
          summary={summary}
          onDone={() => {
            setTo('')
            setAmount('')
            flow.dispatch({ type: 'reset' })
          }}
          onEdit={() => flow.dispatch({ type: 'review' })}
          onStartOver={() => {
            setTo('')
            setAmount('')
            flow.dispatch({ type: 'reset' })
          }}
        />
      </>
    )
  }

  if (flow.state.step === 'review' && check.recipient && check.amountRaw !== undefined && quote) {
    const recipient = check.recipient
    const amountRaw = check.amountRaw
    const account = wallet.address
    const totalMax = amountRaw + ceilNativeToUsdc6(quote.maxFeeNative)
    return (
      <>
        <PageTitle title="Review transfer" subtitle="Check every detail. You will confirm once more in your wallet." />
        <section className="card p-5">
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="label">From</dt>
              <dd className="mono mt-1 break-all">{wallet.address}</dd>
            </div>
            <div>
              <dt className="label">To</dt>
              <dd className="mono mt-1 break-all" data-testid="review-recipient">{recipient}</dd>
            </div>
            <div>
              <dt className="label">Amount</dt>
              <dd className="display mt-1 text-3xl font-bold tabular-nums">
                {formatUsdcAmount(amountRaw)} <span className="text-base font-medium text-[var(--subtle)]">USDC</span>
              </dd>
            </div>
            <div className="inner space-y-2 p-3.5">
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--muted)]">Estimated network fee</dt>
                <dd className="tabular-nums font-semibold">~{fee6(quote.expectedFeeNative)} USDC</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--muted)]">Maximum network fee</dt>
                <dd className="tabular-nums font-semibold">{fee6(quote.maxFeeNative)} USDC</dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2">
                <dt className="font-semibold">Most you can pay</dt>
                <dd className="tabular-nums font-bold">{formatUsdcAmount(totalMax, 6)} USDC</dd>
              </div>
            </div>
          </dl>
          <p className="mt-3 text-xs text-pretty text-[var(--muted)]">
            Arc fees are paid in USDC. Any unused part of the maximum fee is not charged. Transfers are final and cannot be reversed.
          </p>
          <div className="mt-5 grid gap-2">
            <button
              type="button"
              className="btn btn-primary"
              // The live balance and fee are re-checked on every render: if they no longer cover the transfer, Confirm is off.
              disabled={busy || Boolean(sendingDisabledReason) || !check.canReview}
              onClick={() =>
                check.canReview &&
                void flow.submit({
                  from: account,
                  to: recipient,
                  amountRaw,
                  quote,
                  balancesUpdatedAt: balances.dataUpdatedAt,
                  refresh: () => refreshInputs(getPublicClient(), { account, to: recipient, amountRaw }),
                  onFresh: (fresh) => {
                    queryClient.setQueryData(['balances', account], { usdc: fresh.usdc, native: fresh.native })
                    queryClient.setQueryData(['fee', account, recipient, amountRaw.toString()], fresh.quote)
                  },
                })
              }
            >
              Confirm in wallet
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => flow.dispatch({ type: 'back' })}>
              Edit transfer
            </button>
          </div>
          {!check.canReview && (
            <div className="mt-3">
              <Notice tone="error" title="This transfer can no longer be sent">
                {check.amountError ?? check.fundsError ?? check.toError ?? 'Your balance or the network fee changed. Edit the transfer.'}
              </Notice>
            </div>
          )}
          {sendingDisabledReason && (
            <div className="mt-3">
              <Notice tone="warning">{sendingDisabledReason}</Notice>
            </div>
          )}
        </section>
      </>
    )
  }

  const balanceText = balances.data ? formatUsdcAmount(balances.data.usdc) : undefined
  const reviewDisabled = !check.canReview || Boolean(sendingDisabledReason) || tokenVerified !== true
  const waitingText: Record<string, string> = {
    recipient: 'Enter a recipient',
    amount: 'Enter an amount',
    balance: 'Loading your balance…',
    fee: 'Estimating network fee…',
  }

  return (
    <>
      <PageTitle title="Send USDC" subtitle="Send USDC to any address on Arc Mainnet." />
      <section className="card space-y-5 p-5">
        <div>
          <label htmlFor="recipient" className="label">Recipient address</label>
          <input
            id="recipient"
            className="field mono mt-2 text-sm"
            placeholder="0x…"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={Boolean(check.toError)}
            aria-describedby="recipient-help"
          />
          <p id="recipient-help" role={check.toError ? 'alert' : undefined} className={`mt-1.5 text-xs ${check.toError ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}`}>
            {check.toError ?? (check.recipient ? `Sending to ${formatAddress(check.recipient)}` : 'Double check the address. Transfers cannot be reversed.')}
          </p>
        </div>

        <div>
          <label htmlFor="amount" className="label">Amount</label>
          <div className="inner mt-2 p-4">
            <div className="flex items-baseline gap-2">
              <input
                id="amount"
                className="display w-full bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:text-slate-300"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  setAmount(normalizeAmountInput(e.target.value))
                  setMaxError(undefined)
                }}
                autoComplete="off"
                aria-invalid={Boolean(check.amountError)}
                aria-describedby="amount-help"
              />
              <span className="text-sm font-medium text-[var(--subtle)]">USDC</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-xs">
              <span className="text-[var(--muted)]">
                {balanceText ? `Balance: ${balanceText} USDC` : balances.isError ? 'Balance unavailable' : 'Loading balance…'}
              </span>
              <button
                type="button"
                className="btn btn-ghost !min-h-9 !px-2 !text-xs"
                onClick={() => void onMax()}
                disabled={maxing || !check.recipient || !balances.data || balances.data.usdc === 0n}
                title={check.recipient ? 'Use the most you can send after the network fee' : 'Enter a recipient first'}
              >
                {maxing && <Spinner className="size-3" />} Max
              </button>
            </div>
          </div>
          <p id="amount-help" role={check.amountError || maxError ? 'alert' : undefined} className="mt-1.5 text-xs text-[var(--danger)]">
            {check.amountError ?? maxError}
          </p>
        </div>

        {balances.isError && (
          <Notice
            tone="error"
            title="Couldn't load your balance"
            action={
              <button type="button" className="btn btn-secondary !min-h-10 !px-4 !text-sm" onClick={() => void balances.refetch()}>
                <RefreshCw className="size-4" aria-hidden="true" /> Retry
              </button>
            }
          >
            {describeReadError(balances.error)} Sending is disabled until it loads.
          </Notice>
        )}

        <div className="inner space-y-2 p-3.5 text-sm" aria-live="polite">
          <div className="flex justify-between gap-3">
            <span className="text-[var(--muted)]">Network fee</span>
            <span className="tabular-nums font-semibold">
              {quote ? (
                `~${fee6(quote.expectedFeeNative)} USDC`
              ) : quoteQuery.isFetching ? (
                <Spinner />
              ) : (
                '—'
              )}
            </span>
          </div>
          {quote && (
            <div className="flex justify-between gap-3 text-xs">
              <span className="text-[var(--muted)]">Maximum</span>
              <span className="tabular-nums">{fee6(quote.maxFeeNative)} USDC</span>
            </div>
          )}
        </div>

        {check.fundsError && <Notice tone="error">{check.fundsError}</Notice>}
        {quoteError && (
          <Notice
            tone="error"
            title="Couldn't estimate the network fee"
            action={
              <button type="button" className="btn btn-secondary !min-h-10 !px-4 !text-sm" onClick={() => void quoteQuery.refetch()}>
                <RefreshCw className="size-4" aria-hidden="true" /> Retry
              </button>
            }
          >
            {quoteError}
          </Notice>
        )}
        {sendingDisabledReason && <Notice tone="warning">{sendingDisabledReason}</Notice>}
        {tokenVerified === undefined && !sendingDisabledReason && (
          <p className="text-xs text-[var(--muted)]">Verifying the USDC contract on Arc…</p>
        )}

        {wallet.status === 'wrong-chain' ? (
          <button type="button" className="btn btn-primary w-full" onClick={wallet.switchToArc} disabled={wallet.switching}>
            {wallet.switching ? 'Check your wallet…' : 'Switch to Arc Mainnet'}
          </button>
        ) : (
          <button type="button" className="btn btn-primary w-full" disabled={reviewDisabled} onClick={() => flow.dispatch({ type: 'review' })}>
            {check.canReview ? 'Review transfer' : check.fundsError || check.amountError || check.toError ? 'Fix the details above' : check.waitingFor ? waitingText[check.waitingFor] : 'Review transfer'}
          </button>
        )}
        <p className="text-center text-xs text-[var(--muted)]">Sending on {NETWORK.chain.name}. Real USDC, irreversible.</p>
      </section>
    </>
  )
}
