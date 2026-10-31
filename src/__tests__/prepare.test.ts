import { describe, expect, test } from 'bun:test'
import { createPublicClient, custom, encodeAbiParameters, toHex } from 'viem'
import { arcMainnet } from '@/config/network'
import { PREPARE, PrepareTimeoutError, QUOTE_MAX_AGE_MS, decidePrepared, needsRefresh, refreshInputs } from '@/lib/prepare'
import { buildFeeQuote } from '@/lib/fees'

const ME = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const GWEI = 10n ** 9n
const N = 10n ** 12n
const quote = (baseGwei = 20n) => buildFeeQuote({ gasEstimate: 65_000n, baseFeePerGas: baseGwei * GWEI, maxPriorityFeePerGas: 5n * GWEI })

describe('freshness', () => {
  const now = 1_000_000
  test('recent data is used as is (no network wait before the wallet)', () => {
    expect(needsRefresh({ quoteCreatedAt: now - 1000, balancesUpdatedAt: now - 1000, now })).toBe(false)
  })
  test('old or missing data is never used to authorize a send', () => {
    expect(needsRefresh({ quoteCreatedAt: now - QUOTE_MAX_AGE_MS - 1, balancesUpdatedAt: now, now })).toBe(true)
    expect(needsRefresh({ quoteCreatedAt: now, balancesUpdatedAt: now - 60_000, now })).toBe(true)
    expect(needsRefresh({ quoteCreatedAt: now, balancesUpdatedAt: 0, now })).toBe(true)
    expect(needsRefresh({ quoteCreatedAt: 0, balancesUpdatedAt: now, now })).toBe(true)
  })
})

describe('re-validation after a refresh', () => {
  const shown = quote().maxFeeNative
  const fresh = (over: Partial<{ usdc: bigint; native: bigint; q: ReturnType<typeof quote> }> = {}) => ({
    quote: over.q ?? quote(),
    usdc: over.usdc ?? 10_000_000n,
    native: over.native ?? 10_000_000n * N,
  })
  test('unchanged conditions proceed with the fresh quote', () => {
    const d = decidePrepared(fresh(), { amountRaw: 1_000_000n, shownMaxFeeNative: shown })
    expect(d.ok).toBe(true)
  })
  test('a balance that dropped below the amount is refused', () => {
    const d = decidePrepared(fresh({ usdc: 500_000n, native: 500_000n * N }), { amountRaw: 1_000_000n, shownMaxFeeNative: shown })
    expect(d).toMatchObject({ ok: false, kind: 'funds' })
  })
  test('an amount that no longer leaves room for the fee is refused', () => {
    const d = decidePrepared(fresh({ usdc: 1_000_000n, native: 1_000_000n * N }), { amountRaw: 1_000_000n, shownMaxFeeNative: shown })
    expect(d).toMatchObject({ ok: false, kind: 'funds' })
  })
  test('a fee that rose more than 10% sends the user back to review; small moves are accepted', () => {
    expect(decidePrepared(fresh({ q: quote(200n) }), { amountRaw: 1_000_000n, shownMaxFeeNative: shown })).toMatchObject({ ok: false, kind: 'fee-changed' })
    expect(decidePrepared(fresh({ q: quote(21n) }), { amountRaw: 1_000_000n, shownMaxFeeNative: shown }).ok).toBe(true)
  })
})

describe('refreshInputs', () => {
  function client(delayMs: number, log: Array<{ method: string; at: number }>) {
    return createPublicClient({
      chain: arcMainnet,
      transport: custom(
        {
          request: (async ({ method }: { method: string }) => {
            log.push({ method, at: performance.now() })
            await new Promise((r) => setTimeout(r, delayMs))
            switch (method) {
              case 'eth_call':
                return encodeAbiParameters([{ type: 'uint256' }], [7_000_000n])
              case 'eth_getBalance':
                return toHex(7_000_000n * N)
              case 'eth_estimateGas':
                return toHex(65_000n)
              case 'eth_getBlockByNumber':
                return { number: '0x1', hash: `0x${'0'.repeat(64)}`, timestamp: '0x1', baseFeePerGas: toHex(20n * GWEI), transactions: [] }
              case 'eth_maxPriorityFeePerGas':
                return toHex(5n * GWEI)
              default:
                throw new Error(method)
            }
          }) as never,
        },
        { retryCount: 0 },
      ),
    })
  }

  test('reads fee, USDC balance and native balance in parallel', async () => {
    const log: Array<{ method: string; at: number }> = []
    const started = performance.now()
    const result = await refreshInputs(client(150, log), { account: ME, to: OTHER, amountRaw: 1n }, 2000)
    const elapsed = performance.now() - started
    expect(result.usdc).toBe(7_000_000n)
    expect(result.native).toBe(7_000_000n * N)
    expect(result.quote.gasLimit).toBe(78_000n)
    expect(log.length).toBeGreaterThanOrEqual(5)
    expect(Math.max(...log.map((l) => l.at)) - Math.min(...log.map((l) => l.at))).toBeLessThan(60) // all started together
    expect(elapsed).toBeLessThan(450) // ~1 latency, not 5
  })
  test('stops at its deadline with a clear error', async () => {
    const log: Array<{ method: string; at: number }> = []
    const started = performance.now()
    await expect(refreshInputs(client(2000, log), { account: ME, to: OTHER, amountRaw: 1n }, 200)).rejects.toBeInstanceOf(PrepareTimeoutError)
    expect(performance.now() - started).toBeLessThan(800)
    expect(PREPARE.refreshTimeoutMs).toBe(10_000)
  })
})
