import type { ReactNode } from 'react'
import { Home, ArrowUpRight, ArrowDownLeft, ListOrdered, LogOut } from 'lucide-react'
import { NETWORK, explorerAddressUrl } from '@/config/network'
import { Link, useRoute, type RoutePath } from '@/router'
import { useWallet } from '@/hooks/useWallet'
import { useChainHealth, useOnline } from '@/hooks/useChainData'
import { useReceiptWatcher } from '@/hooks/useLocalTxs'
import { formatAddress } from '@/lib/format'
import { ConnectButton } from '@/components/ConnectButton'
import { ExternalLink, Notice } from '@/components/ui'

const NAV: Array<{ to: RoutePath; label: string; Icon: typeof Home }> = [
  { to: '/', label: 'Home', Icon: Home },
  { to: '/send', label: 'Send', Icon: ArrowUpRight },
  { to: '/receive', label: 'Receive', Icon: ArrowDownLeft },
  { to: '/activity', label: 'Activity', Icon: ListOrdered },
]

function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span className="flex size-8 items-center justify-center rounded-[10px]" style={{ background: 'var(--accent)' }}>
        <svg viewBox="0 0 32 32" className="size-5" fill="none" aria-hidden="true">
          <path d="M8 10l8 13 8-13" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="display text-xl font-bold">Veltrio</span>
    </span>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const route = useRoute()
  const wallet = useWallet()
  const online = useOnline()
  const { health, refetch, isFetching } = useChainHealth()
  useReceiptWatcher(wallet.address)

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-24">
      <header className="flex items-center justify-between gap-3 py-2">
        <Link to="/" aria-label="Veltrio home">
          <Logo />
        </Link>
        {wallet.address ? (
          <div className="flex items-center gap-1.5">
            <ExternalLink href={explorerAddressUrl(wallet.address)} className="mono rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-xs">
              {formatAddress(wallet.address)}
            </ExternalLink>
            <button type="button" onClick={wallet.disconnect} className="btn btn-ghost size-11 !p-0" aria-label="Disconnect wallet" title="Disconnect">
              <LogOut className="size-4" aria-hidden="true" />
            </button>
          </div>
        ) : (
          // Stays mounted while connecting so an open wallet picker keeps its state and error message.
          <ConnectButton className="!min-h-11 !px-4 !text-sm" label="Connect" />
        )}
      </header>

      <nav aria-label="Main" className="card mt-2 grid grid-cols-4 gap-1 p-1.5">
        {NAV.map(({ to, label, Icon }) => {
          const active = route === to
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? 'page' : undefined}
              className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold transition-colors ${
                active ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:bg-black/5'
              }`}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="mt-4 space-y-3">
        {NETWORK.warnings.map((warning) => (
          <Notice key={warning} tone="warning" title="Configuration warning">
            {warning}
          </Notice>
        ))}
        {!online && (
          <Notice tone="warning" title="You are offline">
            Balances and history may be out of date until your connection returns.
          </Notice>
        )}
        {online && health.status === 'chain-mismatch' && (
          <Notice tone="error" title="RPC is on the wrong network">
            The configured RPC reports chain {health.rpcChainId}, but Veltrio only runs on Arc Mainnet (5042). Sending is disabled. Check your RPC settings.
          </Notice>
        )}
        {online && health.status === 'error' && (
          <Notice
            tone="error"
            title="Can't reach Arc Mainnet"
            action={
              <button type="button" className="btn btn-secondary !min-h-10 !px-4 !text-sm" onClick={refetch} disabled={isFetching}>
                {isFetching ? 'Retrying…' : 'Retry'}
              </button>
            }
          >
            {health.message} Balances shown may be out of date.
          </Notice>
        )}
        {online && health.status === 'stale' && (
          <Notice tone="warning" title="Network data looks stale">
            The latest block the RPC returned is about {Math.round(health.ageSeconds / 60)} min old. Treat balances with caution.
          </Notice>
        )}
        {wallet.status === 'wrong-chain' && (
          <Notice
            tone="warning"
            title="Your wallet is on a different network"
            action={
              <button type="button" className="btn btn-primary !min-h-10 !px-4 !text-sm" onClick={wallet.switchToArc} disabled={wallet.switching}>
                {wallet.switching ? 'Check your wallet…' : 'Switch to Arc Mainnet'}
              </button>
            }
          >
            {wallet.switchMessage ?? 'Veltrio works on Arc Mainnet (chain ID 5042). Sending is disabled until you switch.'}
          </Notice>
        )}
      </div>

      <main className="mt-4 flex-1 space-y-4">{children}</main>

      <footer className="mt-8 px-1 text-center text-xs text-[var(--muted)]">
        <p>Arc Mainnet · Chain ID {NETWORK.chainId}</p>
        {NETWORK.site.domain && <p className="mt-0.5">{NETWORK.site.domain}</p>}
      </footer>
    </div>
  )
}
