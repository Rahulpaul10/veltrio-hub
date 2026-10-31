import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'

/** Tiny path router (no dependency). Paths work with the Netlify SPA fallback in netlify.toml. */
export const ROUTES = ['/', '/send', '/receive', '/activity'] as const
export type RoutePath = (typeof ROUTES)[number]

const NAV_EVENT = 'veltrio:navigate'

function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('popstate', listener)
  window.addEventListener(NAV_EVENT, listener)
  return () => {
    window.removeEventListener('popstate', listener)
    window.removeEventListener(NAV_EVENT, listener)
  }
}

export function useRoute(): RoutePath | 'not-found' {
  const path = useSyncExternalStore(subscribe, () => normalize(window.location.pathname), () => '/')
  return (ROUTES as readonly string[]).includes(path) ? (path as RoutePath) : 'not-found'
}

export function navigate(to: RoutePath): void {
  if (normalize(window.location.pathname) !== to) {
    window.history.pushState({}, '', to)
    window.dispatchEvent(new Event(NAV_EVENT))
  }
  window.scrollTo({ top: 0 })
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: RoutePath
  children: ReactNode
}

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  )
}
