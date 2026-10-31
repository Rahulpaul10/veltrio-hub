/**
 * Registers a DOM (happy-dom) for the integration tests. Import this first in a test file.
 * The real fetch is kept: pure RPC tests in other files use a local HTTP server.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const realFetch = globalThis.fetch
if (typeof document === 'undefined') {
  GlobalRegistrator.register({ url: 'http://localhost:5173/' })
  globalThis.fetch = realFetch
}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export async function unregisterDom(): Promise<void> {
  if (typeof document !== 'undefined') await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
}
