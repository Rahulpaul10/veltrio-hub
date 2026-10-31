import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Connector } from 'wagmi'
import { HistoryView, approxDuration, type HistoryViewProps } from '@/components/TxList'
import { SendStatus } from '@/components/SendStatus'
import { pickConnectors } from '@/components/ConnectButton'
import type { TxItem } from '@/lib/history'

const noop = () => undefined
const HASH = `0x${'cd'.repeat(32)}` as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const N = 10n ** 12n

const item = (over: Partial<TxItem> = {}): TxItem => ({
  id: 'a',
  hash: HASH,
  direction: 'out',
  counterparty: OTHER,
  amountNative: 2_500_000n * N,
  status: 'confirmed',
  blockNumber: 100n,
  logIndex: 0,
  source: 'chain',
  ...over,
})

const base: HistoryViewProps = {
  status: 'ready',
  items: [],
  times: new Map(),
  loadingOlder: false,
  refreshing: false,
  reachedStart: false,
  scannedBlocks: 180_000n,
  onRetry: noop,
  onRefresh: noop,
  onLoadOlder: noop,
}
const html = (over: Partial<HistoryViewProps>) => renderToStaticMarkup(<HistoryView {...base} {...over} />)

describe('history states', () => {
  test('loading shows a busy skeleton, not an empty message', () => {
    const out = html({ status: 'loading' })
    expect(out).toContain('aria-busy="true"')
    expect(out).not.toContain('No transactions found')
  })
  test('unavailable history is clearly different from empty history, and offers retry', () => {
    const out = html({ status: 'error', error: 'Could not reach the Arc RPC. Check your connection.' })
    expect(out).toContain('Transaction history is unavailable')
    expect(out).toContain('does not mean you have no transactions')
    expect(out).toContain('Retry')
    expect(out).not.toContain('No transactions found')
  })
  test('empty history says how far it looked and offers to search older', () => {
    const out = html({})
    expect(out).toContain('No transactions found')
    expect(out).toContain('Searched the last 25 hours')
    expect(out).toContain('Search older')
  })
  test('empty with a full scan says the address has no transfers', () => {
    const out = html({ reachedStart: true })
    expect(out).toContain('This address has no USDC transfers on Arc Mainnet')
    expect(out).not.toContain('Search older')
  })
  test('rows show type, amount, status, date fallback and an explorer link to Arc Mainnet', () => {
    const out = html({ items: [item(), item({ id: 'b', direction: 'in', status: 'pending', source: 'local', blockNumber: undefined, submittedAt: Date.now() })] })
    expect(out).toContain('Sent')
    expect(out).toContain('Received')
    expect(out).toContain('2.50')
    expect(out).toContain('Confirmed')
    expect(out).toContain('Pending')
    expect(out).toContain('Date unavailable')
    expect(out).toContain(`https://explorer.arc.io/tx/${HASH}`)
    expect(out).not.toContain('testnet')
  })
  test('failed transactions explain that no USDC moved', () => {
    const out = html({ items: [item({ status: 'failed' })] })
    expect(out).toContain('Failed')
    expect(out).toContain('No USDC moved')
  })
  test('a stale background refresh keeps the list and warns', () => {
    const out = html({ items: [item()], refreshError: 'The Arc RPC returned an error.' })
    expect(out).toContain('Showing the last loaded history')
    expect(out).toContain('Sent')
  })
  test('limit trims the list for the dashboard', () => {
    const items = [0, 1, 2, 3].map((i) => item({ id: String(i), hash: `0x${String(i).repeat(64)}` as const }))
    const out = html({ items, limit: 2 })
    expect(out.match(/>Sent</g)).toHaveLength(2)
  })
  test('approxDuration', () => {
    expect(approxDuration(1_200n)).toBe('10 minutes')
    expect(approxDuration(72_000n)).toBe('10 hours')
    expect(approxDuration(1_000_000n)).toBe('6 days')
  })
})

describe('send status never claims success early', () => {
  const props = { summary: { to: OTHER, amount: '2.5' }, onDone: noop, onEdit: noop, onStartOver: noop }
  test('awaiting wallet and pending are not success', () => {
    for (const state of [
      { step: 'awaiting_wallet' as const },
      { step: 'pending' as const, hash: HASH, slow: false },
    ]) {
      const out = renderToStaticMarkup(<SendStatus state={state} {...props} />)
      expect(out).not.toContain('Transfer confirmed')
    }
  })
  test('confirmed, failed, rejected and ambiguous errors each say the truth', () => {
    expect(renderToStaticMarkup(<SendStatus state={{ step: 'confirmed', hash: HASH, blockNumber: 7n }} {...props} />)).toContain('Transfer confirmed')
    expect(renderToStaticMarkup(<SendStatus state={{ step: 'failed', hash: HASH }} {...props} />)).toContain('Transfer failed')
    const rejected = renderToStaticMarkup(<SendStatus state={{ step: 'rejected' }} {...props} />)
    expect(rejected).toContain('You declined')
    expect(rejected).toContain('Nothing was sent')
    const unsure = renderToStaticMarkup(<SendStatus state={{ step: 'error', message: 'maybe sent', definitelyNotSent: false }} {...props} />)
    expect(unsure).toContain('Check before you retry')
    expect(unsure).not.toContain('Review transfer again')
    const safe = renderToStaticMarkup(<SendStatus state={{ step: 'error', message: 'nope', definitelyNotSent: true }} {...props} />)
    expect(safe).toContain('Review transfer again')
  })
  test('a slow pending transaction is described as pending, not failed', () => {
    const out = renderToStaticMarkup(<SendStatus state={{ step: 'pending', hash: HASH, slow: true }} {...props} />)
    expect(out).toContain('still pending, not failed')
  })
})

describe('wallet picker', () => {
  const c = (id: string) => ({ id, uid: id, name: id }) as unknown as Connector
  test('hides the generic injected entry when specific wallets were discovered', () => {
    expect(pickConnectors([c('injected'), c('io.metamask')], true).map((x) => x.id)).toEqual(['io.metamask'])
  })
  test('uses the generic injected entry only when a browser provider exists', () => {
    expect(pickConnectors([c('injected')], true).map((x) => x.id)).toEqual(['injected'])
    expect(pickConnectors([c('injected')], false)).toEqual([])
  })
})
