import { ArrowDownLeft, ArrowUpRight, RefreshCw } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import { NETWORK } from '@/config/network'
import { Link } from '@/router'
import { useWallet } from '@/hooks/useWallet'
import { useBalances, useChainHealth } from '@/hooks/useChainData'
import { describeReadError } from '@/lib/errors'
import { formatUsdcAmount } from '@/lib/format'
import { ConnectPrompt } from '@/components/ConnectPrompt'
import { HistoryPanel } from '@/components/HistoryPanel'
import { Notice, Spinner } from '@/components/ui'

function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  const color = { ok: 'var(--success)', warn: 'var(--warning)', bad: 'var(--danger)', idle: 'var(--subtle)' }[tone]
  return <span className="inline-block size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
}

export function Dashboard() {
  const wallet = useWallet()
  const balances = useBalances(wallet.address)
  const { health } = useChainHealth()

  if (!wallet.address) {
    return (
      <ConnectPrompt
        title="Your USDC on Arc Mainnet"
        body="Connect a wallet to see your USDC balance, send and receive, and follow every transfer to confirmation."
      />
    )
  }

  const healthTone = health.status === 'ok' ? 'ok' : health.status === 'checking' ? 'idle' : health.status === 'stale' ? 'warn' : 'bad'
  const healthText =
    health.status === 'ok'
      ? `Live · block ${health.block.toLocaleString('en-US')}`
      : health.status === 'stale'
        ? `Stale · last block ${health.block.toLocaleString('en-US')}`
        : health.status === 'checking'
          ? 'Checking…'
          : health.status === 'chain-mismatch'
            ? 'RPC on wrong network'
            : 'RPC unreachable'

  return (
    <>
      <section className="card p-5" aria-label="USDC balance">
        <div className="flex items-center justify-between">
          <span className="label">USDC balance</span>
          <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <StatusDot tone={healthTone} /> {healthText}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2.5">
          <TokenUSDC variant="branded" size={32} />
          {balances.data ? (
            <p className="display text-4xl font-bold tabular-nums">
              {formatUsdcAmount(balances.data.usdc)} <span className="text-lg font-medium text-[var(--subtle)]">USDC</span>
            </p>
          ) : balances.isError ? (
            <p className="display text-2xl font-bold text-[var(--subtle)]">Unavailable</p>
          ) : (
            <div className="h-10 w-44 animate-pulse rounded-xl bg-black/5" aria-label="Loading balance" aria-busy="true" />
          )}
        </div>
        {balances.isError && (
          <div className="mt-3">
            <Notice
              tone="error"
              title={balances.data ? 'Balance may be out of date' : "Couldn't load your balance"}
              action={
                <button type="button" className="btn btn-secondary !min-h-10 !px-4 !text-sm" onClick={() => void balances.refetch()} disabled={balances.isFetching}>
                  {balances.isFetching ? <Spinner /> : <RefreshCw className="size-4" aria-hidden="true" />} Retry
                </button>
              }
            >
              {describeReadError(balances.error)}
            </Notice>
          </div>
        )}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Link to="/send" className="btn btn-primary">
            <ArrowUpRight className="size-4" aria-hidden="true" /> Send
          </Link>
          <Link to="/receive" className="btn btn-secondary">
            <ArrowDownLeft className="size-4" aria-hidden="true" /> Receive
          </Link>
        </div>
      </section>

      <section className="card p-5" aria-label="Network status">
        <h2 className="label">Network</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--muted)]">Veltrio network</dt>
            <dd className="font-semibold">Arc Mainnet ({NETWORK.chainId})</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--muted)]">Your wallet</dt>
            <dd className="flex items-center gap-1.5 font-semibold">
              <StatusDot tone={wallet.status === 'ready' ? 'ok' : 'warn'} />
              {wallet.status === 'ready' ? 'Connected to Arc Mainnet' : `On another network${wallet.chainId ? ` (${wallet.chainId})` : ''}`}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--muted)]">Wallet</dt>
            <dd className="font-semibold">{wallet.walletName ?? 'Connected'}</dd>
          </div>
        </dl>
      </section>

      <section className="card p-5" aria-label="Recent activity">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="label">Recent activity</h2>
          <Link to="/activity" className="text-sm font-semibold text-[var(--accent-hover)] hover:underline">
            View all
          </Link>
        </div>
        <HistoryPanel address={wallet.address} limit={5} />
      </section>
    </>
  )
}
