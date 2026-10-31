import { describe, expect, test } from 'bun:test'
import { pad, toHex, type Hex } from 'viem'
import {
  TRANSFER_TOPIC,
  fetchWindow,
  isStalePending,
  mergeHistory,
  parseTransferLog,
  scanBackward,
  scanRange,
  windowsDescending,
  type HistoryClient,
  type RawLog,
} from '@/lib/history'
import type { LocalTx } from '@/lib/txStore'

const ME = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const THIRD = '0x3333333333333333333333333333333333333333' as const
const N = 10n ** 12n
const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`

function log(opts: { block: bigint; index?: number; hash?: Hex; from: string; to: string; valueNative: bigint }): RawLog {
  return {
    blockNumber: toHex(opts.block),
    logIndex: toHex(opts.index ?? 0),
    transactionHash: opts.hash ?? hashOf(Number(opts.block)),
    topics: [TRANSFER_TOPIC, pad(opts.from as Hex, { size: 32 }), pad(opts.to as Hex, { size: 32 })],
    data: toHex(opts.valueNative, { size: 32 }),
  }
}

/** A fake chain: logs live at block numbers; filters respect range and the from/to topic positions. */
function fakeClient(logs: RawLog[], head = 100_000n, opts: { failAt?: bigint } = {}): HistoryClient & { calls: number } {
  const client = {
    calls: 0,
    getBlockNumber: () => Promise.resolve(head),
    getTransferLogs: ({ fromBlock, toBlock, topics }: { fromBlock: bigint; toBlock: bigint; topics: readonly (Hex | null)[] }) => {
      client.calls++
      if (toBlock - fromBlock + 1n > 10_000n) return Promise.reject(new Error('requested range too large'))
      if (opts.failAt !== undefined && opts.failAt >= fromBlock && opts.failAt <= toBlock) return Promise.reject(new Error('HTTP request failed. Status: 503'))
      const matches = logs.filter((l) => {
        const b = BigInt(l.blockNumber)
        if (b < fromBlock || b > toBlock) return false
        return topics.every((t, i) => t === null || t.toLowerCase() === (l.topics[i] ?? '').toLowerCase())
      })
      return Promise.resolve(matches)
    },
    getBlockTimestamp: () => Promise.resolve(0),
  }
  return client
}

describe('log parsing', () => {
  test('decodes sender, recipient, block and 18-decimal value', () => {
    const parsed = parseTransferLog(log({ block: 77n, index: 3, from: ME, to: OTHER, valueNative: 2_500_000n * N }))
    expect(parsed).toMatchObject({ blockNumber: 77n, logIndex: 3, amountNative: 2_500_000n * N })
    expect(parsed?.from).toBe(ME)
    expect(parsed?.to).toBe(OTHER)
  })
  test('ignores logs that are not 3-topic Transfers', () => {
    const base = log({ block: 1n, from: ME, to: OTHER, valueNative: 1n })
    expect(parseTransferLog({ ...base, topics: [...base.topics, base.topics[0]] })).toBeNull()
    expect(parseTransferLog({ ...base, topics: [pad('0x01', { size: 32 }), ...base.topics.slice(1)] })).toBeNull()
  })
})

describe('windows and scanning', () => {
  test('windows never exceed the RPC range limit and cover everything', () => {
    const w = windowsDescending(0n, 25_000n)
    expect(w.every(([lo, hi]) => hi - lo + 1n <= 9_000n)).toBe(true)
    expect(w[0]?.[1]).toBe(25_000n)
    expect(w.at(-1)?.[0]).toBe(0n)
    const covered = w.reduce((n, [lo, hi]) => n + (hi - lo + 1n), 0n)
    expect(covered).toBe(25_001n)
  })
  test('fetchWindow merges sent and received and dedupes', async () => {
    const client = fakeClient([
      log({ block: 5n, from: ME, to: OTHER, valueNative: 1n * N }),
      log({ block: 6n, from: OTHER, to: ME, valueNative: 2n * N }),
      log({ block: 7n, from: OTHER, to: THIRD, valueNative: 3n * N }),
    ])
    const found = await fetchWindow(client, ME, 0n, 100n)
    expect(found.map((f) => f.blockNumber).sort()).toEqual([5n, 6n])
  })
  test('scanBackward finds old activity, stops early once enough is found, and reports how far it looked', async () => {
    const logs = [log({ block: 99_000n, from: ME, to: OTHER, valueNative: N }), log({ block: 50_000n, from: OTHER, to: ME, valueNative: N })]
    const client = fakeClient(logs, 100_000n)
    const early = await scanBackward(client, ME, { toBlock: 100_000n, maxChunks: 24, wantItems: 1 })
    expect(early.transfers).toHaveLength(1)
    expect(early.reachedStart).toBe(false)
    const full = await scanBackward(client, ME, { toBlock: 100_000n, maxChunks: 24, wantItems: 10 })
    expect(full.transfers).toHaveLength(2)
    expect(full.reachedStart).toBe(true)
    expect(full.oldestScanned).toBe(0n)
  })
  test('scanBackward stops at maxChunks and says history is not fully loaded', async () => {
    const client = fakeClient([], 1_000_000n)
    const r = await scanBackward(client, ME, { toBlock: 1_000_000n, maxChunks: 4, wantItems: 5, concurrency: 2 })
    expect(r.reachedStart).toBe(false)
    expect(r.oldestScanned).toBe(1_000_000n - 4n * 9_000n + 1n)
  })
  test('a failing window throws, so partial history is never shown as complete', async () => {
    const client = fakeClient([], 100_000n, { failAt: 60_000n })
    await expect(scanBackward(client, ME, { toBlock: 100_000n, maxChunks: 24, wantItems: 10 })).rejects.toThrow('503')
  })
  test('scanRange covers a gap larger than one window', async () => {
    const logs = [log({ block: 20_000n, from: ME, to: OTHER, valueNative: N }), log({ block: 29_999n, from: ME, to: OTHER, valueNative: N })]
    const found = await scanRange(fakeClient(logs), ME, 10_000n, 30_000n)
    expect(found).toHaveLength(2)
    expect(await scanRange(fakeClient(logs), ME, 5n, 4n)).toEqual([])
  })
})

describe('history merge', () => {
  const local = (over: Partial<LocalTx> = {}): LocalTx => ({
    hash: hashOf(900),
    from: ME,
    to: OTHER,
    amountRaw: '1500000',
    createdAt: Date.now(),
    status: 'pending',
    ...over,
  })

  test('shows a pending local tx immediately, above confirmed history', () => {
    const chain = [parseTransferLog(log({ block: 10n, from: OTHER, to: ME, valueNative: 4n * N }))].flatMap((t) => (t ? [t] : []))
    const items = mergeHistory(ME, chain, [local()])
    expect(items.map((i) => i.status)).toEqual(['pending', 'confirmed'])
    expect(items[0]).toMatchObject({ direction: 'out', counterparty: OTHER, amountNative: 1_500_000n * N, source: 'local' })
    expect(items[1]).toMatchObject({ direction: 'in', counterparty: OTHER, source: 'chain' })
  })
  test('the on-chain entry replaces its local twin (no duplicate)', () => {
    const t = parseTransferLog(log({ block: 12n, hash: hashOf(900), from: ME, to: OTHER, valueNative: 1_500_000n * N }))
    const items = mergeHistory(ME, t ? [t] : [], [local({ status: 'confirmed', blockNumber: '12' })])
    expect(items).toHaveLength(1)
    expect(items[0]?.source).toBe('chain')
  })
  test('a failed local tx stays visible (reverts emit no transfer log)', () => {
    const items = mergeHistory(ME, [], [local({ status: 'failed', blockNumber: '30' })])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ status: 'failed', blockNumber: 30n })
  })
  test('orders confirmed items newest first by block then log index', () => {
    const chain = [
      log({ block: 5n, index: 0, from: ME, to: OTHER, valueNative: N }),
      log({ block: 9n, index: 1, from: ME, to: OTHER, valueNative: N, hash: hashOf(91) }),
      log({ block: 9n, index: 4, from: OTHER, to: ME, valueNative: N, hash: hashOf(92) }),
    ].flatMap((l) => {
      const p = parseTransferLog(l)
      return p ? [p] : []
    })
    const items = mergeHistory(ME, chain, [])
    expect(items.map((i) => [i.blockNumber, i.logIndex])).toEqual([
      [9n, 4],
      [9n, 1],
      [5n, 0],
    ])
  })
  test('unrelated transfers are dropped', () => {
    const t = parseTransferLog(log({ block: 3n, from: OTHER, to: THIRD, valueNative: N }))
    expect(mergeHistory(ME, t ? [t] : [], [])).toEqual([])
  })
  test('pending older than 10 minutes is flagged as unconfirmed, not failed', () => {
    const [item] = mergeHistory(ME, [], [local({ createdAt: 1_000 })])
    expect(item).toBeDefined()
    if (!item) return
    expect(item.status).toBe('pending')
    expect(isStalePending(item, 1_000 + 11 * 60_000)).toBe(true)
    expect(isStalePending(item, 1_000 + 60_000)).toBe(false)
  })
})
