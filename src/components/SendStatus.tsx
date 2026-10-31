import { CheckCircle2, XCircle, Clock, Hand } from 'lucide-react'
import { explorerTxUrl } from '@/config/network'
import { Link } from '@/router'
import type { SendState } from '@/lib/sendFlow'
import { ExternalLink, Notice, Spinner } from '@/components/ui'

interface Props {
  state: SendState
  summary: { to: string; amount: string }
  onDone: () => void
  onEdit: () => void
  onStartOver: () => void
}

/** Shows exactly what is known about the transfer. "Confirmed" only appears after an on-chain success receipt. */
export function SendStatus({ state, summary, onDone, onEdit, onStartOver }: Props) {
  switch (state.step) {
    case 'preparing':
      return (
        <section className="card p-6 text-center" aria-live="polite" aria-busy="true">
          <Spinner className="mx-auto size-8 text-[var(--accent)]" />
          <h2 className="display mt-4 text-xl font-bold">Checking your latest fee and balance</h2>
          <p className="mt-1.5 text-sm text-pretty text-[var(--muted)]">
            The numbers on screen were a little old, so Veltrio is re-checking them before opening your wallet. If the Arc RPC is slow this stops after a few seconds and nothing is sent.
          </p>
        </section>
      )
    case 'awaiting_wallet':
      return (
        <section className="card p-6 text-center" aria-live="polite">
          <Spinner className="mx-auto size-8 text-[var(--accent)]" />
          <h2 className="display mt-4 text-xl font-bold">Approve in your wallet</h2>
          <p className="mt-1.5 text-sm text-pretty text-[var(--muted)]">
            Confirm the transfer of {summary.amount} USDC in your wallet. Nothing is sent until you approve it. Keep this page open.
          </p>
        </section>
      )
    case 'pending':
      return (
        <section className="card p-6 text-center" aria-live="polite">
          <Clock className="mx-auto size-8 text-[var(--warning)]" aria-hidden="true" />
          <h2 className="display mt-4 text-xl font-bold">Submitted, waiting for confirmation</h2>
          <p className="mt-1.5 text-sm text-pretty text-[var(--muted)]">
            {summary.amount} USDC to {summary.to.slice(0, 10)}… is not final until Arc confirms it.
          </p>
          {state.slow && (
            <div className="mt-3 text-left">
              <Notice tone="warning" title="Taking longer than usual">
                The transaction is still pending, not failed. You can leave this page. Veltrio keeps checking and updates Activity.
              </Notice>
            </div>
          )}
          <div className="mt-4 flex flex-col items-center gap-2 text-sm">
            <ExternalLink href={explorerTxUrl(state.hash)}>View on Arc Explorer</ExternalLink>
            <Link to="/activity" className="font-semibold text-[var(--accent-hover)] hover:underline">
              Go to Activity
            </Link>
          </div>
        </section>
      )
    case 'confirmed':
      return (
        <section className="card p-6 text-center" aria-live="polite">
          <CheckCircle2 className="mx-auto size-9 text-[var(--success)]" aria-hidden="true" />
          <h2 className="display mt-4 text-xl font-bold">Transfer confirmed</h2>
          <p className="mt-1.5 text-sm text-pretty text-[var(--muted)]">
            {summary.amount} USDC was confirmed on Arc Mainnet{state.blockNumber > 0n ? ` in block ${state.blockNumber.toLocaleString('en-US')}` : ''}.
          </p>
          <div className="mt-4 flex flex-col items-center gap-3">
            <ExternalLink href={explorerTxUrl(state.hash)}>View on Arc Explorer</ExternalLink>
            <button type="button" className="btn btn-primary w-full" onClick={onDone}>
              Done
            </button>
          </div>
        </section>
      )
    case 'failed':
      return (
        <section className="card p-6 text-center" aria-live="polite">
          <XCircle className="mx-auto size-9 text-[var(--danger)]" aria-hidden="true" />
          <h2 className="display mt-4 text-xl font-bold">Transfer failed</h2>
          <p className="mt-1.5 text-sm text-pretty text-[var(--muted)]">
            The transaction reached Arc but reverted, so no USDC moved. The network fee was still charged. The sender or recipient may be restricted.
          </p>
          <div className="mt-4 flex flex-col items-center gap-3">
            <ExternalLink href={explorerTxUrl(state.hash)}>View on Arc Explorer</ExternalLink>
            <button type="button" className="btn btn-secondary w-full" onClick={onStartOver}>
              Start over
            </button>
          </div>
        </section>
      )
    case 'unverified':
      return (
        <section className="card p-6 text-center" aria-live="polite">
          <Clock className="mx-auto size-9 text-[var(--warning)]" aria-hidden="true" />
          <h2 className="display mt-4 text-xl font-bold">Included, but not verified</h2>
          <p className="mt-1.5 text-sm text-pretty text-[var(--muted)]">
            The transaction was included on Arc, but Veltrio could not match the expected {summary.amount} USDC transfer in its receipt. Do not treat it as paid until you check the explorer.
          </p>
          <div className="mt-4 flex flex-col items-center gap-3">
            <ExternalLink href={explorerTxUrl(state.hash)}>View on Arc Explorer</ExternalLink>
            <button type="button" className="btn btn-secondary w-full" onClick={onStartOver}>
              Start a new transfer
            </button>
          </div>
        </section>
      )
    case 'rejected':
      return (
        <section className="card p-6 text-center" aria-live="polite">
          <Hand className="mx-auto size-8 text-[var(--muted)]" aria-hidden="true" />
          <h2 className="display mt-4 text-xl font-bold">You declined the request</h2>
          <p className="mt-1.5 text-sm text-pretty text-[var(--muted)]">Nothing was sent and no fee was charged.</p>
          <div className="mt-4 grid gap-2">
            <button type="button" className="btn btn-primary" onClick={onEdit}>
              Review transfer again
            </button>
            <button type="button" className="btn btn-ghost" onClick={onStartOver}>
              Cancel
            </button>
          </div>
        </section>
      )
    case 'error':
      return (
        <section className="card space-y-4 p-6" aria-live="polite">
          <Notice tone="error" title={state.definitelyNotSent ? 'Transfer not sent' : 'Check before you retry'}>
            {state.message}
          </Notice>
          {state.definitelyNotSent ? (
            <div className="grid gap-2">
              <button type="button" className="btn btn-primary" onClick={onEdit}>
                Review transfer again
              </button>
              <button type="button" className="btn btn-ghost" onClick={onStartOver}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="grid gap-2">
              <Link to="/activity" className="btn btn-secondary">
                Check Activity
              </Link>
              <button type="button" className="btn btn-ghost" onClick={onStartOver}>
                I checked, start a new transfer
              </button>
            </div>
          )}
        </section>
      )
    default:
      return null
  }
}
