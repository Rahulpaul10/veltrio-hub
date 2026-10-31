import type { Address, Hex } from 'viem'
import { ARC_MAINNET_CHAIN_ID } from '@/config/network'

/**
 * Transactions this browser submitted, kept so a pending transfer shows up in
 * Activity immediately and so failed (reverted) transfers, which emit no
 * transfer log, are still visible. Only hashes of real submitted transactions
 * are stored; nothing here is ever generated.
 */
export interface LocalTx {
  hash: Hex
  from: Address
  to: Address
  /** 6-decimal USDC amount as a decimal string. */
  amountRaw: string
  createdAt: number
  status: 'pending' | 'confirmed' | 'failed' | 'unverified'
  blockNumber?: string
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const MAX_ENTRIES = 50
const EMPTY: readonly LocalTx[] = []

export const storageKey = (address: Address) => `veltrio:v1:${ARC_MAINNET_CHAIN_ID}:${address.toLowerCase()}`

function isLocalTx(value: unknown): value is LocalTx {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.hash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(v.hash) &&
    typeof v.from === 'string' &&
    typeof v.to === 'string' &&
    typeof v.amountRaw === 'string' &&
    /^\d+$/.test(v.amountRaw) &&
    typeof v.createdAt === 'number' &&
    (v.status === 'pending' || v.status === 'confirmed' || v.status === 'failed' || v.status === 'unverified')
  )
}

export class LocalTxStore {
  private cache = new Map<string, readonly LocalTx[]>()
  private listeners = new Set<() => void>()

  constructor(private readonly storage: StorageLike | undefined) {}

  get = (address: Address): readonly LocalTx[] => {
    const key = storageKey(address)
    const cached = this.cache.get(key)
    if (cached) return cached
    let loaded: readonly LocalTx[] = EMPTY
    try {
      const raw = this.storage?.getItem(key)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) loaded = parsed.filter(isLocalTx)
      }
    } catch {
      loaded = EMPTY
    }
    this.cache.set(key, loaded)
    return loaded
  }

  private write(address: Address, next: readonly LocalTx[]): void {
    const trimmed = [...next].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ENTRIES)
    this.cache.set(storageKey(address), trimmed)
    try {
      this.storage?.setItem(storageKey(address), JSON.stringify(trimmed))
    } catch {
      // Storage full or blocked: the in-memory copy still works for this session.
    }
    for (const listener of this.listeners) listener()
  }

  add(tx: LocalTx): void {
    const existing = this.get(tx.from).filter((t) => t.hash.toLowerCase() !== tx.hash.toLowerCase())
    this.write(tx.from, [tx, ...existing])
  }

  update(address: Address, hash: Hex, patch: Partial<Pick<LocalTx, 'status' | 'blockNumber'>>): void {
    const current = this.get(address)
    if (!current.some((t) => t.hash === hash)) return
    this.write(
      address,
      current.map((t) => (t.hash === hash ? { ...t, ...patch } : t)),
    )
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

function safeLocalStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export const localTxStore = new LocalTxStore(safeLocalStorage())
