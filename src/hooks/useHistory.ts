import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Address } from 'viem'
import { getPublicClient } from '@/lib/rpc'
import { describeReadError } from '@/lib/errors'
import {
  getHistoryClient,
  mergeHistory,
  scanBackward,
  scanRange,
  type ChainTransfer,
  type HistoryClient,
  type TxItem,
} from '@/lib/history'
import { useLocalTxs } from '@/hooks/useLocalTxs'

const INITIAL_CHUNKS = 24
const OLDER_CHUNKS = 48
const WANT_ITEMS = 20
const POLL_MS = 20_000

/**
 * Last good scan per address, kept in memory for the session. Moving between Home and Activity then shows the
 * history at once and only scans the blocks produced since, instead of repeating dozens of RPC requests.
 */
interface HistorySnapshot {
  transfers: ChainTransfer[]
  head: bigint
  oldest: bigint
  reachedStart: boolean
}
const snapshots = new Map<string, HistorySnapshot>()
/** Test helper. */
export function clearHistoryCache(): void {
  snapshots.clear()
}

interface HistoryState {
  status: 'loading' | 'ready' | 'error'
  transfers: ChainTransfer[]
  head?: bigint
  oldestScanned?: bigint
  reachedStart: boolean
  error?: string
  /** A background refresh failed; the list shown may be out of date. */
  refreshError?: string
  loadingOlder: boolean
  refreshing: boolean
}

type Action =
  | { type: 'reset' }
  | { type: 'initial-ok'; transfers: ChainTransfer[]; head: bigint; oldest: bigint; reachedStart: boolean }
  | { type: 'initial-error'; error: string }
  | { type: 'refresh-start' }
  | { type: 'refresh-ok'; transfers: ChainTransfer[]; head: bigint }
  | { type: 'refresh-error'; error: string }
  | { type: 'older-start' }
  | { type: 'older-ok'; transfers: ChainTransfer[]; oldest: bigint; reachedStart: boolean }
  | { type: 'older-error'; error: string }

const initial: HistoryState = { status: 'loading', transfers: [], reachedStart: false, loadingOlder: false, refreshing: false }

function union(a: ChainTransfer[], b: ChainTransfer[]): ChainTransfer[] {
  const map = new Map<string, ChainTransfer>()
  for (const t of [...a, ...b]) map.set(`${t.hash}:${t.logIndex}`, t)
  return [...map.values()]
}

function reducer(state: HistoryState, action: Action): HistoryState {
  switch (action.type) {
    case 'reset':
      return initial
    case 'initial-ok':
      return {
        ...state,
        status: 'ready',
        transfers: action.transfers,
        head: action.head,
        oldestScanned: action.oldest,
        reachedStart: action.reachedStart,
        error: undefined,
        refreshError: undefined,
      }
    case 'initial-error':
      return { ...state, status: 'error', error: action.error }
    case 'refresh-start':
      return { ...state, refreshing: true }
    case 'refresh-ok':
      return { ...state, refreshing: false, transfers: union(state.transfers, action.transfers), head: action.head, refreshError: undefined }
    case 'refresh-error':
      return { ...state, refreshing: false, refreshError: action.error }
    case 'older-start':
      return { ...state, loadingOlder: true }
    case 'older-ok':
      return {
        ...state,
        loadingOlder: false,
        transfers: union(state.transfers, action.transfers),
        oldestScanned: action.oldest,
        reachedStart: action.reachedStart,
        refreshError: undefined,
      }
    case 'older-error':
      return { ...state, loadingOlder: false, refreshError: action.error }
    default:
      return state
  }
}

export interface UseHistoryResult {
  status: HistoryState['status']
  items: TxItem[]
  error?: string
  refreshError?: string
  loadingOlder: boolean
  refreshing: boolean
  reachedStart: boolean
  /** Number of blocks searched so far, newest first. */
  scannedBlocks?: bigint
  retry: () => void
  refresh: () => void
  loadOlder: () => void
}

export function useHistory(address: Address | undefined, client: HistoryClient = getHistoryClient()): UseHistoryResult {
  const [state, dispatch] = useReducer(reducer, initial)
  const locals = useLocalTxs(address)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  // Identifies the current address/scan. Results from an older run are dropped.
  const run = useRef<object | null>(null)

  const runInitial = useCallback(async () => {
    if (!address) return
    const token = {}
    run.current = token
    dispatch({ type: 'reset' })
    const cached = snapshots.get(address.toLowerCase())
    if (cached) {
      dispatch({ type: 'initial-ok', transfers: cached.transfers, head: cached.head, oldest: cached.oldest, reachedStart: cached.reachedStart })
      try {
        const head = await client.getBlockNumber()
        const fresh = head > cached.head ? await scanRange(client, address, cached.head + 1n, head) : []
        if (run.current !== token) return
        dispatch({ type: 'refresh-ok', transfers: fresh, head: head > cached.head ? head : cached.head })
      } catch (error) {
        if (run.current !== token) return
        dispatch({ type: 'refresh-error', error: describeReadError(error) })
      }
      return
    }
    try {
      const head = await client.getBlockNumber()
      const result = await scanBackward(client, address, { toBlock: head, maxChunks: INITIAL_CHUNKS, wantItems: WANT_ITEMS })
      if (run.current !== token) return
      dispatch({ type: 'initial-ok', transfers: result.transfers, head, oldest: result.oldestScanned, reachedStart: result.reachedStart })
    } catch (error) {
      if (run.current !== token) return
      dispatch({ type: 'initial-error', error: describeReadError(error) })
    }
  }, [address, client])

  const refresh = useCallback(async () => {
    const current = stateRef.current
    if (!address || current.status !== 'ready' || current.head === undefined || current.refreshing) return
    const token = run.current
    dispatch({ type: 'refresh-start' })
    try {
      const head = await client.getBlockNumber()
      const fresh = head > current.head ? await scanRange(client, address, current.head + 1n, head) : []
      if (run.current !== token) return
      dispatch({ type: 'refresh-ok', transfers: fresh, head: head > current.head ? head : current.head })
    } catch (error) {
      if (run.current !== token) return
      dispatch({ type: 'refresh-error', error: describeReadError(error) })
    }
  }, [address, client])

  const loadOlder = useCallback(async () => {
    const current = stateRef.current
    if (!address || current.status !== 'ready' || current.oldestScanned === undefined || current.reachedStart || current.loadingOlder) return
    const token = run.current
    dispatch({ type: 'older-start' })
    try {
      const result = await scanBackward(client, address, {
        toBlock: current.oldestScanned - 1n,
        maxChunks: OLDER_CHUNKS,
        wantItems: WANT_ITEMS,
      })
      if (run.current !== token) return
      dispatch({ type: 'older-ok', transfers: result.transfers, oldest: result.oldestScanned, reachedStart: result.reachedStart })
    } catch (error) {
      if (run.current !== token) return
      dispatch({ type: 'older-error', error: describeReadError(error) })
    }
  }, [address, client])

  useEffect(() => {
    void runInitial()
    return () => {
      run.current = null
    }
  }, [runInitial])

  const confirmedLocals = locals.filter((t) => t.status === 'confirmed').length
  useEffect(() => {
    if (confirmedLocals > 0) void refresh()
  }, [confirmedLocals, refresh])

  useEffect(() => {
    if (state.status !== 'ready') return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [state.status, refresh])

  useEffect(() => {
    if (!address || state.status !== 'ready' || state.head === undefined || state.oldestScanned === undefined) return
    snapshots.set(address.toLowerCase(), {
      transfers: state.transfers,
      head: state.head,
      oldest: state.oldestScanned,
      reachedStart: state.reachedStart,
    })
  }, [address, state.status, state.transfers, state.head, state.oldestScanned, state.reachedStart])

  const items = useMemo(() => (address ? mergeHistory(address, state.transfers, locals) : []), [address, state.transfers, locals])

  return {
    status: state.status,
    items,
    error: state.error,
    refreshError: state.refreshError,
    loadingOlder: state.loadingOlder,
    refreshing: state.refreshing,
    reachedStart: state.reachedStart,
    scannedBlocks: state.head !== undefined && state.oldestScanned !== undefined ? state.head - state.oldestScanned + 1n : undefined,
    retry: () => void runInitial(),
    refresh: () => void refresh(),
    loadOlder: () => void loadOlder(),
  }
}

/** Block timestamps (seconds) for the transactions on screen. Missing entries mean "date unavailable". */
export function useBlockTimes(blockNumbers: bigint[]): Map<string, number> {
  const unique = [...new Set(blockNumbers.map((n) => n.toString()))]
  const results = useQueries({
    queries: unique.map((n) => ({
      queryKey: ['block-time', n],
      queryFn: async () => Number((await getPublicClient().getBlock({ blockNumber: BigInt(n) })).timestamp),
      staleTime: Infinity,
      gcTime: 60 * 60 * 1000,
    })),
  })
  const map = new Map<string, number>()
  results.forEach((r, i) => {
    const key = unique[i]
    if (key !== undefined && r.data !== undefined) map.set(key, r.data)
  })
  return map
}
