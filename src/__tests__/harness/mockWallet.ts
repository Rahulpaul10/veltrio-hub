import { toHex, type Hex } from 'viem'

type Listener = (...args: unknown[]) => void

export interface SentTx {
  from: string
  to: string
  data: string
  gas?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  value?: string
}

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
  }
}

/** A browser wallet (EIP-1193). It never signs or broadcasts anything: it records what it was asked. */
export class MockWallet {
  accounts: string[]
  chainId = 5042
  connected = false
  mode: 'approve' | 'reject' | 'hang' | 'fail' = 'approve'
  rejectConnect = false
  rejectSwitch = false
  sent: SentTx[] = []
  /** Timeline of every request the wallet received: milliseconds (performance.now) and method. */
  timeline: Array<{ at: number; method: string }> = []
  /** Artificial delay before the wallet answers any request (simulates a slow provider). */
  latencyMs = 0
  hashes: Hex[] = []
  private listeners = new Map<string, Set<Listener>>()
  private release: ((hash: Hex) => void) | undefined

  constructor(account: string) {
    this.accounts = [account]
  }

  get nextHash(): Hex {
    return `0x${(this.hashes.length + 1).toString(16).padStart(64, 'a')}` as Hex
  }

  request = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    this.timeline.push({ at: performance.now(), method })
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs))
    switch (method) {
      case 'eth_requestAccounts':
        if (this.rejectConnect) throw new RpcError('User rejected the request.', 4001)
        this.connected = true
        return this.accounts
      case 'eth_accounts':
        return this.connected ? this.accounts : []
      case 'eth_chainId':
        return toHex(this.chainId)
      case 'net_version':
        return String(this.chainId)
      case 'wallet_switchEthereumChain': {
        if (this.rejectSwitch) throw new RpcError('User rejected the request.', 4001)
        const target = Number((params?.[0] as { chainId: string }).chainId)
        this.setChain(target)
        return null
      }
      case 'wallet_revokePermissions':
        return null
      case 'eth_sendTransaction': {
        const tx = params?.[0] as SentTx
        this.sent.push(tx)
        if (this.mode === 'reject') throw new RpcError('User rejected the request.', 4001)
        if (this.mode === 'fail') throw new RpcError('Internal JSON-RPC error.', -32603)
        const hash = this.nextHash
        if (this.mode === 'hang') {
          return new Promise<Hex>((resolve) => {
            this.release = (h) => {
              this.hashes.push(h)
              resolve(h)
            }
          })
        }
        this.hashes.push(hash)
        return hash
      }
      default:
        throw new RpcError(`MockWallet: unsupported method ${method}`, -32601)
    }
  }

  /** Finish a transaction that was left waiting for approval (mode "hang"). */
  approvePending(): Hex {
    const hash = this.nextHash
    this.release?.(hash)
    return hash
  }

  on = (event: string, listener: Listener) => {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
  }

  removeListener = (event: string, listener: Listener) => {
    this.listeners.get(event)?.delete(listener)
  }

  emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args)
  }

  setChain(chainId: number) {
    this.chainId = chainId
    this.emit('chainChanged', toHex(chainId))
  }

  setAccounts(accounts: string[]) {
    this.accounts = accounts
    this.emit('accountsChanged', accounts)
  }
}
