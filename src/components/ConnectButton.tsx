import { useEffect, useMemo, useState } from 'react'
import { useConnect, type Connector } from 'wagmi'
import { Wallet, X } from 'lucide-react'
import { isUserRejection } from '@/lib/errors'
import { Notice, Spinner } from '@/components/ui'

/** Hides the generic "Injected" entry when specific wallets were discovered (EIP-6963). */
export function pickConnectors(connectors: readonly Connector[], hasLegacyProvider: boolean): Connector[] {
  const specific = connectors.filter((c) => c.id !== 'injected')
  if (specific.length > 0) return specific
  return hasLegacyProvider ? connectors.filter((c) => c.id === 'injected') : []
}

export function ConnectButton({ className = '', label = 'Connect wallet' }: { className?: string; label?: string }) {
  const { connectors, connectAsync, isPending, reset } = useConnect()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [pendingId, setPendingId] = useState<string | undefined>()

  const hasLegacyProvider = typeof window !== 'undefined' && Boolean((window as { ethereum?: unknown }).ethereum)
  const options = useMemo(() => pickConnectors(connectors, hasLegacyProvider), [connectors, hasLegacyProvider])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const close = () => {
    setOpen(false)
    setMessage(undefined)
    reset()
  }

  const connect = async (connector: Connector) => {
    setMessage(undefined)
    setPendingId(connector.uid)
    try {
      await connectAsync({ connector })
      close()
    } catch (error) {
      setMessage(
        isUserRejection(error)
          ? 'You declined the connection request in your wallet.'
          : 'Could not connect to this wallet. Unlock it, then try again.',
      )
    } finally {
      setPendingId(undefined)
    }
  }

  return (
    <>
      <button type="button" className={`btn btn-primary ${className}`} onClick={() => setOpen(true)}>
        <Wallet className="size-4" aria-hidden="true" />
        {label}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Connect a wallet">
          <button type="button" className="absolute inset-0 bg-black/30" aria-label="Close" onClick={close} />
          <div className="card relative w-full max-w-md rounded-b-none p-5 sm:rounded-b-3xl" style={{ background: 'var(--surface-strong)' }}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="display text-lg font-bold">Connect a wallet</h2>
              <button type="button" onClick={close} className="btn btn-ghost size-11 !p-0" aria-label="Close">
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            {options.length === 0 ? (
              <Notice tone="warning" title="No browser wallet found">
                Install a wallet such as MetaMask, Rabby or Coinbase Wallet, or open Veltrio inside your wallet app's built-in browser, then reload.
              </Notice>
            ) : (
              <ul className="space-y-2">
                {options.map((connector) => (
                  <li key={connector.uid}>
                    <button
                      type="button"
                      className="btn btn-secondary w-full !justify-between"
                      disabled={isPending}
                      onClick={() => void connect(connector)}
                    >
                      <span className="flex items-center gap-3">
                        {connector.icon ? (
                          <img src={connector.icon} alt="" className="size-6 rounded-md" />
                        ) : (
                          <Wallet className="size-5" aria-hidden="true" />
                        )}
                        {connector.name}
                      </span>
                      {pendingId === connector.uid && <Spinner />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {message && (
              <div className="mt-3">
                <Notice tone="error">{message}</Notice>
              </div>
            )}
            <p className="mt-4 text-xs text-pretty text-[var(--muted)]">
              Veltrio never sees your keys. Every transfer opens a confirmation in your wallet first.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
