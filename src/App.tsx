import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link, useRoute } from '@/router'
import { Shell } from '@/components/Shell'
import { Dashboard } from '@/pages/Dashboard'
import { Send } from '@/pages/Send'
import { Receive } from '@/pages/Receive'
import { Activity } from '@/pages/Activity'

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Veltrio render error', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <h1 className="display text-xl font-bold">Something went wrong</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Your funds are not affected. Reload the page to continue.</p>
        <button type="button" className="btn btn-primary mt-4" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}

function NotFound() {
  return (
    <section className="card p-6 text-center">
      <h1 className="display text-xl font-bold">Page not found</h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">That page does not exist.</p>
      <Link to="/" className="btn btn-primary mt-4">
        Back to home
      </Link>
    </section>
  )
}

function Routes() {
  const route = useRoute()
  switch (route) {
    case '/':
      return <Dashboard />
    case '/send':
      return <Send />
    case '/receive':
      return <Receive />
    case '/activity':
      return <Activity />
    default:
      return <NotFound />
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Shell>
        <Routes />
      </Shell>
    </ErrorBoundary>
  )
}
