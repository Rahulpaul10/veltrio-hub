import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, ExternalLink as ExternalLinkIcon, Info, Loader2, XCircle } from 'lucide-react'

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} aria-hidden="true" />
}

export function ExternalLink({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 font-semibold text-[var(--accent-hover)] hover:underline ${className}`}
    >
      {children}
      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
    </a>
  )
}

type NoticeTone = 'info' | 'warning' | 'error' | 'success'

const toneStyles: Record<NoticeTone, { color: string; background: string; Icon: typeof Info }> = {
  info: { color: 'var(--accent-hover)', background: 'rgba(16,97,166,0.08)', Icon: Info },
  warning: { color: 'var(--warning)', background: 'rgba(154,91,0,0.09)', Icon: AlertTriangle },
  error: { color: 'var(--danger)', background: 'rgba(186,43,76,0.08)', Icon: XCircle },
  success: { color: 'var(--success)', background: 'rgba(26,128,71,0.09)', Icon: Check },
}

export function Notice({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: NoticeTone
  title?: string
  children?: ReactNode
  action?: ReactNode
}) {
  const { color, background, Icon } = toneStyles[tone]
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className="flex gap-3 rounded-2xl p-3.5 text-sm" style={{ background, color }}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5 text-[var(--ink-2)]' : 'text-[var(--ink-2)]'}>{children}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  )
}

export function CopyButton({ value, label = 'Copy', className = '' }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setFailed(false)
    } catch {
      setFailed(true)
      setCopied(false)
    }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setCopied(false)
      setFailed(false)
    }, 2000)
  }

  return (
    <button type="button" onClick={() => void copy()} className={`btn btn-secondary ${className}`} aria-live="polite">
      {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      {copied ? 'Copied' : failed ? 'Copy failed, select the address' : label}
    </button>
  )
}

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="px-1">
      <h1 className="display text-2xl font-bold text-balance">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-pretty text-[var(--muted)]">{subtitle}</p>}
    </div>
  )
}
