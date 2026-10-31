import { ArrowDownLeft, ArrowUpRight, RefreshCw } from 'lucide-react'
import { explorerTxUrl } from '@/config/network'
import { formatAddress, formatDateTime, formatNativeAsUsdc } from '@/lib/format'
import { isStalePending, type TxItem } from '@/lib/history'
import { ExternalLink, Notice, Spinner } from '@/components/ui'

export function StatusPill({ status, stale = false }: { status: TxItem['status']; stale?: boolean }) {
  const map = {
    pending: { label: stale ? 'Not confirmed' : 'Pending', color: 'var(--warning)', bg: 'rgba(154,91,0,0.1)' },
    confirmed: { label: 'Confirmed', color: 'var(--success)', bg: 'rgba(26,128,71,0.1)' },
    failed: { label: 'Failed', color: 'var(--danger)', bg: 'rgba(186,43,76,0.1)' },
    unverified: { label: 'Check explorer', color: 'var(--warning)', bg: 'rgba(154,91,0,0.1)' },
  } as const
  const { label, color, bg } = map[status]
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color, background: bg }}>
      {status === 'pending' && !stale && <Spinner className="size-3" />}
      {label}
    </span>
  )
}

/** Approximate span of chain history searched, from block count (Arc produces about 2 blocks per second). */
export function approxDuration(blocks: bigint): string {
  const seconds = Number(blocks) / 2
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} minutes`
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} hours`
  return `${Math.round(seconds / 86_400)} days`
}

function TxRow({ item, time }: { item: TxItem; time?: number }) {
  const outgoing = item.direction === 'out'
  const stale = isStalePending(item)
  const Icon = outgoing ? ArrowUpRight : ArrowDownLeft
  const date = time !== undefined ? formatDateTime(time) : item.submittedAt !== undefined ? formatDateTime(item.submittedAt / 1000) : 'Date unavailable'
  const amount = formatNativeAsUsdc(item.amountNative)
  return (
    <li className="py-3.5">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: outgoing ? 'rgba(18,45,69,0.08)' : 'rgba(26,128,71,0.1)', color: outgoing ? 'var(--ink)' : 'var(--success)' }}
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-semibold">{outgoing ? 'Sent' : 'Received'}</p>
            <p className={`display tabular-nums font-bold ${item.status === 'failed' ? 'text-[var(--subtle)] line-through' : ''}`}>
              {outgoing ? '−' : '+'}
              {amount} <span className="text-xs font-medium text-[var(--subtle)]">USDC</span>
            </p>
          </div>
          <p className="mono truncate text-xs text-[var(--muted)]">
            {outgoing ? 'To' : 'From'} {formatAddress(item.counterparty)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
            <StatusPill status={item.status} stale={stale} />
            <span>{date}</span>
            <ExternalLink href={explorerTxUrl(item.hash)} className="mono !text-xs">
              {formatAddress(item.hash, 8, 6)}
            </ExternalLink>
          </div>
          {item.status === 'failed' && (
            <p className="mt-1 text-xs text-[var(--danger)]">The transaction was included but reverted. No USDC moved; the network fee was still charged.</p>
          )}
          {item.status === 'unverified' && (
            <p className="mt-1 text-xs text-[var(--warning)]">
              Included on Arc, but Veltrio could not match the expected USDC transfer in the receipt. Do not treat it as paid until you check the explorer.
            </p>
          )}
          {stale && (
            <p className="mt-1 text-xs text-[var(--warning)]">
              No confirmation yet. If you sped up or cancelled it in your wallet, this transaction may have been replaced. Check the explorer link.
            </p>
          )}
        </div>
      </div>
    </li>
  )
}

export interface HistoryViewProps {
  status: 'loading' | 'ready' | 'error'
  items: TxItem[]
  times: Map<string, number>
  error?: string
  refreshError?: string
  loadingOlder: boolean
  refreshing: boolean
  reachedStart: boolean
  scannedBlocks?: bigint
  limit?: number
  onRetry: () => void
  onRefresh: () => void
  onLoadOlder: () => void
}

export function HistoryView(props: HistoryViewProps) {
  const { status, items, times, error, refreshError, loadingOlder, refreshing, reachedStart, scannedBlocks, limit, onRetry, onRefresh, onLoadOlder } = props
  const shown = limit ? items.slice(0, limit) : items
  const searched = scannedBlocks !== undefined ? approxDuration(scannedBlocks) : undefined

  if (status === 'loading' && items.length === 0) {
    return (
      <div aria-busy="true" aria-label="Loading transactions" className="space-y-3 py-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex animate-pulse items-center gap-3">
            <div className="size-9 rounded-full bg-black/5" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 rounded bg-black/5" />
              <div className="h-3 w-2/3 rounded bg-black/5" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div>
      {status === 'error' && (
        <div className="mb-2">
          <Notice
            tone="error"
            title="Transaction history is unavailable"
            action={
              <button type="button" className="btn btn-secondary !min-h-10 !px-4 !text-sm" onClick={onRetry}>
                <RefreshCw className="size-4" aria-hidden="true" /> Retry
              </button>
            }
          >
            {error ?? 'Could not load history.'} This does not mean you have no transactions.
            {items.length > 0 && ' Only transactions sent from this browser are shown below.'}
          </Notice>
        </div>
      )}
      {status === 'ready' && refreshError && (
        <div className="mb-2">
          <Notice
            tone="warning"
            title="Showing the last loaded history"
            action={
              <button type="button" className="btn btn-secondary !min-h-10 !px-4 !text-sm" onClick={onRefresh}>
                Retry
              </button>
            }
          >
            {refreshError}
          </Notice>
        </div>
      )}

      {shown.length > 0 ? (
        <ul className="divide-y divide-[var(--border)]">
          {shown.map((item) => (
            <TxRow key={item.id} item={item} time={item.blockNumber !== undefined ? times.get(item.blockNumber.toString()) : undefined} />
          ))}
        </ul>
      ) : (
        status === 'ready' && (
          <div className="py-6 text-center">
            <p className="font-semibold">No transactions found</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-pretty text-[var(--muted)]">
              {reachedStart
                ? 'This address has no USDC transfers on Arc Mainnet.'
                : `Nothing in the last ${searched ?? 'few hours'} of Arc blocks. Older activity may exist.`}
            </p>
          </div>
        )
      )}

      {status === 'ready' && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
          <span>
            {reachedStart ? 'Full history loaded.' : searched ? `Searched the last ${searched} of blocks.` : ''}
          </span>
          <span className="flex items-center gap-1">
            <button type="button" className="btn btn-ghost !min-h-10 !text-xs" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? <Spinner className="size-3" /> : <RefreshCw className="size-3" aria-hidden="true" />} Refresh
            </button>
            {!reachedStart && !limit && (
              <button type="button" className="btn btn-ghost !min-h-10 !text-xs" onClick={onLoadOlder} disabled={loadingOlder}>
                {loadingOlder && <Spinner className="size-3" />} Search older
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
