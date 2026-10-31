import { getAddress, pad, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { ARC_MAINNET_CHAIN_ID, NATIVE_USDC_EMITTER } from '@/config/network'
import { Amount, usdcDecimalsFor, usdcToGasToken } from '@/onchain-money'
import { getPublicClient } from '@/lib/rpc'
import type { LocalTx } from '@/lib/txStore'

/**
 * Transaction history from Arc's native USDC system emitter (EIP-7708). It logs every
 * explicit USDC movement (native sends and ERC-20 transfers) at 18 decimals, so one
 * movement is one entry. The RPC limits eth_getLogs to 10,000 blocks per call, so
 * history is scanned in windows of CHUNK_SIZE blocks, newest first.
 */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const
export const CHUNK_SIZE = 9_000n
/** Blocks at roughly two per second: about 75 minutes per window. */
export const STALE_PENDING_MS = 10 * 60 * 1000

export interface RawLog {
  blockNumber: Hex
  logIndex: Hex
  transactionHash: Hex
  topics: readonly Hex[]
  data: Hex
}

export interface HistoryClient {
  getBlockNumber(): Promise<bigint>
  getTransferLogs(filter: { fromBlock: bigint; toBlock: bigint; topics: readonly (Hex | null)[] }): Promise<RawLog[]>
  getBlockTimestamp(blockNumber: bigint): Promise<number>
}

export interface ChainTransfer {
  hash: Hex
  logIndex: number
  blockNumber: bigint
  from: Address
  to: Address
  /** 18-decimal native view of the amount. */
  amountNative: bigint
}

export function createHistoryClient(client: PublicClient): HistoryClient {
  return {
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getTransferLogs({ fromBlock, toBlock, topics }) {
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [{ address: NATIVE_USDC_EMITTER, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics: [...topics] }],
      })
      const out: RawLog[] = []
      for (const log of logs) {
        if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) continue
        out.push({
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          transactionHash: log.transactionHash,
          topics: log.topics,
          data: log.data,
        })
      }
      return out
    },
    async getBlockTimestamp(blockNumber) {
      const block = await client.getBlock({ blockNumber })
      return Number(block.timestamp)
    },
  }
}

const historyClients = new WeakMap<PublicClient, HistoryClient>()

/** One stable HistoryClient per RPC client, so hooks do not re-run effects on every render. */
export function getHistoryClient(): HistoryClient {
  const client = getPublicClient()
  let cached = historyClients.get(client)
  if (!cached) {
    cached = createHistoryClient(client)
    historyClients.set(client, cached)
  }
  return cached
}

export function parseTransferLog(log: RawLog): ChainTransfer | null {
  if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null
  const [, fromTopic, toTopic] = log.topics
  if (!fromTopic || !toTopic) return null
  return {
    hash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
    blockNumber: BigInt(log.blockNumber),
    from: getAddress(`0x${fromTopic.slice(26)}`),
    to: getAddress(`0x${toTopic.slice(26)}`),
    amountNative: BigInt(log.data === '0x' ? '0x0' : log.data),
  }
}

/** All transfers to or from `address` inside one window of at most CHUNK_SIZE blocks. */
export async function fetchWindow(
  client: HistoryClient,
  address: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ChainTransfer[]> {
  const me = pad(address.toLowerCase() as Hex, { size: 32 })
  const [sent, received] = await Promise.all([
    client.getTransferLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, me] }),
    client.getTransferLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, me] }),
  ])
  const byKey = new Map<string, ChainTransfer>()
  for (const log of [...sent, ...received]) {
    const parsed = parseTransferLog(log)
    if (parsed) byKey.set(`${parsed.hash}:${parsed.logIndex}`, parsed)
  }
  return [...byKey.values()]
}

/** Windows covering [from, to], newest first, each at most `size` blocks. */
export function windowsDescending(from: bigint, to: bigint, size: bigint = CHUNK_SIZE): Array<[bigint, bigint]> {
  const windows: Array<[bigint, bigint]> = []
  let hi = to
  while (hi >= from) {
    const lo = hi - size + 1n > from ? hi - size + 1n : from
    windows.push([lo, hi])
    hi = lo - 1n
  }
  return windows
}

export interface ScanResult {
  transfers: ChainTransfer[]
  /** Lowest block that was fully scanned. */
  oldestScanned: bigint
  /** True once the scan reached block 0, so there is nothing older to find. */
  reachedStart: boolean
}

export interface ScanOptions {
  /** Highest block to include. */
  toBlock: bigint
  maxChunks: number
  /** Stop early once at least this many transfers were found. */
  wantItems: number
  concurrency?: number
  chunkSize?: bigint
  signal?: AbortSignal
}

/**
 * Scans backwards from `toBlock`. Throws if any window fails after the transport's
 * retries, so a partial scan is never presented as a complete one.
 */
export async function scanBackward(client: HistoryClient, address: Address, options: ScanOptions): Promise<ScanResult> {
  const { toBlock, maxChunks, wantItems, concurrency = 3, chunkSize = CHUNK_SIZE, signal } = options
  const transfers: ChainTransfer[] = []
  let cursor = toBlock
  let chunksUsed = 0
  let reachedStart = toBlock < 0n

  while (!reachedStart && chunksUsed < maxChunks && transfers.length < wantItems) {
    if (signal?.aborted) throw new DOMException('Scan aborted', 'AbortError')
    const batch: Array<[bigint, bigint]> = []
    for (let i = 0; i < concurrency && chunksUsed + batch.length < maxChunks && cursor >= 0n; i++) {
      const lo = cursor - chunkSize + 1n > 0n ? cursor - chunkSize + 1n : 0n
      batch.push([lo, cursor])
      cursor = lo - 1n
    }
    const results = await Promise.all(batch.map(([lo, hi]) => fetchWindow(client, address, lo, hi)))
    for (const found of results) transfers.push(...found)
    chunksUsed += batch.length
    if (cursor < 0n) reachedStart = true
  }
  return { transfers, oldestScanned: cursor + 1n, reachedStart }
}

/** Scans [fromBlock, toBlock] (used to pick up new blocks after the first scan). */
export async function scanRange(
  client: HistoryClient,
  address: Address,
  fromBlock: bigint,
  toBlock: bigint,
  concurrency = 3,
): Promise<ChainTransfer[]> {
  if (toBlock < fromBlock) return []
  const windows = windowsDescending(fromBlock, toBlock)
  const out: ChainTransfer[] = []
  for (let i = 0; i < windows.length; i += concurrency) {
    const results = await Promise.all(windows.slice(i, i + concurrency).map(([lo, hi]) => fetchWindow(client, address, lo, hi)))
    for (const found of results) out.push(...found)
  }
  return out
}

export type TxStatus = 'pending' | 'confirmed' | 'failed' | 'unverified'

export interface TxItem {
  id: string
  hash: Hex
  direction: 'in' | 'out'
  counterparty: Address
  /** 18-decimal native view; convert for display with formatNativeAsUsdc. */
  amountNative: bigint
  status: TxStatus
  blockNumber?: bigint
  logIndex?: number
  /** Milliseconds, only for transactions submitted from this browser. */
  submittedAt?: number
  source: 'chain' | 'local'
}

export function mergeHistory(address: Address, transfers: readonly ChainTransfer[], locals: readonly LocalTx[]): TxItem[] {
  const me = address.toLowerCase()
  const items: TxItem[] = []
  const onChain = new Set<string>()

  for (const t of transfers) {
    const outgoing = t.from.toLowerCase() === me
    if (!outgoing && t.to.toLowerCase() !== me) continue
    onChain.add(t.hash.toLowerCase())
    items.push({
      id: `${t.hash}:${t.logIndex}`,
      hash: t.hash,
      direction: outgoing ? 'out' : 'in',
      counterparty: outgoing ? t.to : t.from,
      amountNative: t.amountNative,
      status: 'confirmed',
      blockNumber: t.blockNumber,
      logIndex: t.logIndex,
      source: 'chain',
    })
  }

  for (const l of locals) {
    // Once the chain scan has the transaction, the on-chain entry wins.
    if (onChain.has(l.hash.toLowerCase()) && l.status !== 'failed' && l.status !== 'unverified') continue
    items.push({
      id: `local:${l.hash}`,
      hash: l.hash,
      direction: 'out',
      counterparty: l.to,
      amountNative: usdcToGasToken(ARC_MAINNET_CHAIN_ID, Amount.fromRaw(BigInt(l.amountRaw), usdcDecimalsFor(ARC_MAINNET_CHAIN_ID))).raw,
      status: l.status,
      blockNumber: l.blockNumber ? BigInt(l.blockNumber) : undefined,
      submittedAt: l.createdAt,
      source: 'local',
    })
  }

  const rank = (i: TxItem) => (i.status === 'pending' ? Number.MAX_SAFE_INTEGER : Number(i.blockNumber ?? 0n))
  return items.sort((a, b) => {
    const diff = rank(b) - rank(a)
    if (diff !== 0) return diff
    if (a.status === 'pending' && b.status === 'pending') return (b.submittedAt ?? 0) - (a.submittedAt ?? 0)
    return (b.logIndex ?? 0) - (a.logIndex ?? 0)
  })
}

export function isStalePending(item: TxItem, now = Date.now()): boolean {
  return item.status === 'pending' && item.submittedAt !== undefined && now - item.submittedAt > STALE_PENDING_MS
}
