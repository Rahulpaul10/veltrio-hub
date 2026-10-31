import { Wallet } from 'lucide-react'
import { useWallet } from '@/hooks/useWallet'
import { ConnectButton } from '@/components/ConnectButton'
import { Spinner } from '@/components/ui'

export function ConnectPrompt({ title = 'Connect your wallet', body }: { title?: string; body: string }) {
  const wallet = useWallet()
  return (
    <section className="card p-6 text-center">
      <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-[var(--surface-muted)]">
        <Wallet className="size-6 text-[var(--accent)]" aria-hidden="true" />
      </span>
      <h2 className="display mt-4 text-xl font-bold text-balance">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-xs text-sm text-pretty text-[var(--muted)]">{body}</p>
      <div className="mt-5">
        <ConnectButton className="w-full" />
        {wallet.status === 'connecting' && (
          <p className="mt-3 inline-flex items-center gap-2 text-sm text-[var(--muted)]" role="status">
            <Spinner /> Connecting to your wallet…
          </p>
        )}
      </div>
    </section>
  )
}
