import { custom, encodeAbiParameters, toHex, type Hex, type Transport } from 'viem'
import { TRANSFER_TOPIC, type RawLog } from '@/lib/history'
import { NATIVE_USDC_EMITTER } from '@/config/network'

const USDC = '0x3600000000000000000000000000000000000000'
const GWEI = 10n ** 9n
const padTopic = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}` as Hex

interface ReceiptSpec {
  status: 'success' | 'reverted'
  block: bigint
  /** The USDC contract's own Transfer log (6-decimal value), as the real chain emits for an ERC-20 transfer. */
  transfer?: { from: string; to: string; value: bigint }
}

/** An in-memory Arc Mainnet RPC. Nothing leaves the process, so no real funds are involved. */
export class FakeArc {
  chainId = 5042
  head = 5_000_000n
  usdc = 25_000_000n
  nativeExtra = 0n
  logs: RawLog[] = []
  receipts = new Map<string, ReceiptSpec>()
  /** Every RPC request fails like a dropped connection. */
  down = false
  /** Only eth_getLogs fails (history unavailable while balances work). */
  logsDown = false
  requests: string[] = []
  /** Timeline of every RPC request: milliseconds (performance.now) and method. Used by timing tests. */
  timeline: Array<{ at: number; method: string }> = []
  /** Artificial delay applied to every RPC response. */
  latencyMs = 0
  baseFeeGwei = 20n
  /** Methods that are additionally delayed (milliseconds), on top of latencyMs. */
  slowMethods: Record<string, number> = {}

  get native(): bigint {
    return this.usdc * 10n ** 12n + this.nativeExtra
  }

  transport: Transport = custom(
    {
      request: (async (args: { method: string; params?: unknown[] }) => {
        this.timeline.push({ at: performance.now(), method: args.method })
        const delay = this.latencyMs + (this.slowMethods[args.method] ?? 0)
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        return this.handle(args.method, args.params ?? [])
      }) as never,
    },
    { retryCount: 0 },
  )

  addTransferLog(opts: { block: bigint; hash: Hex; from: string; to: string; valueNative: bigint; index?: number }): void {
    const pad = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}` as Hex
    this.logs.push({
      blockNumber: toHex(opts.block),
      logIndex: toHex(opts.index ?? 0),
      transactionHash: opts.hash,
      topics: [TRANSFER_TOPIC, pad(opts.from), pad(opts.to)],
      data: toHex(opts.valueNative, { size: 32 }),
    })
  }

  private handle(method: string, params: unknown[]): unknown {
    this.requests.push(method)
    if (this.down) throw new Error('Failed to fetch')
    switch (method) {
      case 'eth_chainId':
        return toHex(this.chainId)
      case 'eth_blockNumber':
        return toHex(this.head)
      case 'eth_getBlockByNumber': {
        const tag = params[0]
        const number = typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : this.head
        return {
          number: toHex(number),
          hash: `0x${number.toString(16).padStart(64, '0')}`,
          parentHash: `0x${'0'.repeat(64)}`,
          timestamp: toHex(BigInt(Math.floor(Date.now() / 1000))),
          baseFeePerGas: toHex(this.baseFeeGwei * GWEI),
          gasLimit: toHex(30_000_000n),
          gasUsed: '0x0',
          transactions: [],
        }
      }
      case 'eth_call': {
        const call = params[0] as { to: string; data: string }
        if (call.to.toLowerCase() !== USDC) throw new Error('unexpected contract call target ' + call.to)
        const selector = call.data.slice(0, 10)
        if (selector === '0x70a08231') return encodeAbiParameters([{ type: 'uint256' }], [this.usdc])
        if (selector === '0x313ce567') return encodeAbiParameters([{ type: 'uint8' }], [6])
        if (selector === '0x95d89b41') return encodeAbiParameters([{ type: 'string' }], ['USDC'])
        throw new Error('unexpected selector ' + selector)
      }
      case 'eth_getBalance':
        return toHex(this.native)
      case 'eth_estimateGas':
        return toHex(65_000n)
      case 'eth_maxPriorityFeePerGas':
        return toHex(5n * GWEI)
      case 'eth_gasPrice':
        return toHex(25n * GWEI)
      case 'eth_getLogs': {
        if (this.logsDown) throw new Error('HTTP request failed. Status: 503')
        const filter = params[0] as { address: string; fromBlock: Hex; toBlock: Hex; topics: Array<Hex | null> }
        if (filter.address.toLowerCase() !== NATIVE_USDC_EMITTER.toLowerCase()) return []
        const from = BigInt(filter.fromBlock)
        const to = BigInt(filter.toBlock)
        if (to - from + 1n > 10_000n) throw new Error('requested range too large')
        return this.logs.filter((l) => {
          const b = BigInt(l.blockNumber)
          return b >= from && b <= to && filter.topics.every((t, i) => t === null || t.toLowerCase() === (l.topics[i] ?? '').toLowerCase())
        })
      }
      case 'eth_getTransactionReceipt': {
        const hash = String(params[0])
        const spec = this.receipts.get(hash)
        if (!spec) return null
        return {
          transactionHash: hash,
          transactionIndex: '0x0',
          blockHash: `0x${spec.block.toString(16).padStart(64, '0')}`,
          blockNumber: toHex(spec.block),
          from: '0x0000000000000000000000000000000000000001',
          to: USDC,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: toHex(25n * GWEI),
          contractAddress: null,
          logs: spec.transfer
            ? [
                {
                  address: USDC,
                  topics: [TRANSFER_TOPIC, padTopic(spec.transfer.from), padTopic(spec.transfer.to)],
                  data: toHex(spec.transfer.value, { size: 32 }),
                  blockNumber: toHex(spec.block),
                  transactionHash: hash,
                  transactionIndex: '0x0',
                  blockHash: `0x${spec.block.toString(16).padStart(64, '0')}`,
                  logIndex: '0x0',
                  removed: false,
                },
              ]
            : [],
          logsBloom: `0x${'0'.repeat(512)}`,
          status: spec.status === 'success' ? '0x1' : '0x0',
          type: '0x2',
        }
      }
      default:
        throw new Error(`FakeArc: unhandled RPC method ${method}`)
    }
  }
}
