import { describe, expect, test } from 'bun:test'
import { classifyTxError, describeReadError, isUserRejection } from '@/lib/errors'
import { initialSendState, isSendBusy, sendReducer, type SendAction, type SendState } from '@/lib/sendFlow'
import { LocalTxStore, storageKey, type LocalTx, type StorageLike } from '@/lib/txStore'

const HASH = `0x${'ab'.repeat(32)}` as const
const ME = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const

const run = (actions: SendAction[], from: SendState = initialSendState) => actions.reduce(sendReducer, from)

describe('error classification', () => {
  test('user rejection is detected from code, viem name and message', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true)
    expect(isUserRejection({ name: 'UserRejectedRequestError', message: 'User rejected the request.' })).toBe(true)
    expect(isUserRejection({ message: 'wrapped', cause: { code: 4001, message: 'x' } })).toBe(true)
    expect(isUserRejection(new Error('MetaMask Tx Signature: User denied transaction signature.'))).toBe(true)
    expect(isUserRejection(new Error('boom'))).toBe(false)
    expect(classifyTxError({ code: 4001 })).toMatchObject({ kind: 'rejected', definitelyNotSent: true })
  })
  test('insufficient funds, underpriced, wrong chain and reverts are known not sent', () => {
    expect(classifyTxError(new Error('insufficient funds for gas * price + value'))).toMatchObject({ kind: 'insufficient_funds', definitelyNotSent: true })
    expect(classifyTxError(new Error('transaction underpriced'))).toMatchObject({ kind: 'underpriced', definitelyNotSent: true })
    expect(classifyTxError(new Error('The current chain of the wallet (id: 1) does not match the target chain'))).toMatchObject({ kind: 'wrong_chain' })
    expect(classifyTxError(new Error('execution reverted'))).toMatchObject({ kind: 'reverted' })
  })
  test('network and unknown errors are NOT treated as safe to retry', () => {
    expect(classifyTxError(new Error('Failed to fetch'))).toMatchObject({ kind: 'network', definitelyNotSent: false })
    expect(classifyTxError(new Error('request timed out'))).toMatchObject({ kind: 'network', definitelyNotSent: false })
    expect(classifyTxError(new Error('???'))).toMatchObject({ kind: 'unknown', definitelyNotSent: false })
    expect(classifyTxError(undefined)).toMatchObject({ kind: 'unknown', definitelyNotSent: false })
  })
  test('an internal wallet error that viem labels as a revert is still ambiguous', () => {
    const wrapped = { name: 'ContractFunctionExecutionError', message: 'x', cause: { name: 'ContractFunctionRevertedError', message: 'reverted', cause: { name: 'InternalRpcError', message: 'An internal error was received.', details: 'Internal JSON-RPC error.', code: -32603 } } }
    expect(classifyTxError(wrapped)).toMatchObject({ kind: 'unknown', definitelyNotSent: false })
  })
  test('read errors have friendly messages', () => {
    expect(describeReadError(new Error('HTTP request failed. Status: 429'))).toContain('rate limiting')
    expect(describeReadError(new Error('The request took too long to respond: timeout'))).toContain('timed out')
    expect(describeReadError(new Error('TypeError: Failed to fetch'))).toContain('Could not reach')
  })
})

describe('send state machine', () => {
  test('happy path ends in confirmed only after a pending submission', () => {
    const s = run([{ type: 'review' }, { type: 'submit' }, { type: 'submitted', hash: HASH }, { type: 'confirmed', blockNumber: 10n }])
    expect(s).toEqual({ step: 'confirmed', hash: HASH, blockNumber: 10n })
  })
  test('cannot jump to confirmed without being pending', () => {
    expect(run([{ type: 'confirmed', blockNumber: 1n }]).step).toBe('form')
    expect(run([{ type: 'review' }, { type: 'confirmed', blockNumber: 1n }]).step).toBe('review')
    expect(run([{ type: 'review' }, { type: 'submit' }, { type: 'confirmed', blockNumber: 1n }]).step).toBe('awaiting_wallet')
  })
  test('submit is ignored unless reviewing, so a second click cannot open a second wallet prompt', () => {
    const awaiting = run([{ type: 'review' }, { type: 'submit' }])
    expect(awaiting.step).toBe('awaiting_wallet')
    expect(sendReducer(awaiting, { type: 'submit' })).toBe(awaiting)
    const pending = sendReducer(awaiting, { type: 'submitted', hash: HASH })
    expect(sendReducer(pending, { type: 'submit' })).toBe(pending)
    expect(isSendBusy(awaiting)).toBe(true)
    expect(isSendBusy(pending)).toBe(true)
    expect(isSendBusy(initialSendState)).toBe(false)
  })
  test('rejection returns to a retryable, non-error state', () => {
    const s = run([{ type: 'review' }, { type: 'submit' }, { type: 'rejected' }])
    expect(s.step).toBe('rejected')
    expect(sendReducer(s, { type: 'review' }).step).toBe('review')
  })
  test('on-chain revert becomes failed and keeps the hash', () => {
    const s = run([{ type: 'review' }, { type: 'submit' }, { type: 'submitted', hash: HASH }, { type: 'reverted', blockNumber: 5n }])
    expect(s).toEqual({ step: 'failed', hash: HASH, blockNumber: 5n })
  })
  test('slow keeps the transaction pending (it is not a failure)', () => {
    const s = run([{ type: 'review' }, { type: 'submit' }, { type: 'submitted', hash: HASH }, { type: 'slow' }])
    expect(s).toEqual({ step: 'pending', hash: HASH, slow: true })
  })
  test('preparing (stale data refresh) is busy, ignores a second submit, and can only fail safely or proceed', () => {
    const preparing = run([{ type: 'review' }, { type: 'prepare' }])
    expect(preparing.step).toBe('preparing')
    expect(isSendBusy(preparing)).toBe(true)
    expect(sendReducer(preparing, { type: 'submit' })).toBe(preparing)
    expect(sendReducer(preparing, { type: 'prepare' })).toBe(preparing)
    expect(sendReducer(preparing, { type: 'prepared' }).step).toBe('awaiting_wallet')
    expect(sendReducer(preparing, { type: 'rejected' })).toBe(preparing) // no wallet prompt yet, nothing to reject
    expect(sendReducer(preparing, { type: 'error', message: 'x', definitelyNotSent: true })).toMatchObject({ step: 'error', definitelyNotSent: true })
    expect(sendReducer(initialSendState, { type: 'prepared' })).toBe(initialSendState)
  })
  test('after an ambiguous error there is no path back to review (no blind resubmission)', () => {
    const ambiguous = run([{ type: 'review' }, { type: 'submit' }, { type: 'error', message: 'x', definitelyNotSent: false }])
    expect(sendReducer(ambiguous, { type: 'review' })).toBe(ambiguous)
    expect(sendReducer(ambiguous, { type: 'submit' })).toBe(ambiguous)
    const safe = run([{ type: 'review' }, { type: 'submit' }, { type: 'error', message: 'x', definitelyNotSent: true }])
    expect(sendReducer(safe, { type: 'review' }).step).toBe('review')
  })
  test('submission errors keep the "definitely not sent" flag', () => {
    const s = run([{ type: 'review' }, { type: 'submit' }, { type: 'error', message: 'x', definitelyNotSent: false }])
    expect(s).toEqual({ step: 'error', message: 'x', definitelyNotSent: false })
    expect(sendReducer(s, { type: 'reset' })).toEqual(initialSendState)
  })
})

class MemoryStorage implements StorageLike {
  data = new Map<string, string>()
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
}

const tx = (over: Partial<LocalTx> = {}): LocalTx => ({ hash: HASH, from: ME, to: OTHER, amountRaw: '1000000', createdAt: 1, status: 'pending', ...over })

describe('local transaction store', () => {
  test('stores a pending tx, updates it, and persists across instances', () => {
    const storage = new MemoryStorage()
    const store = new LocalTxStore(storage)
    let notified = 0
    store.subscribe(() => notified++)
    store.add(tx())
    expect(store.get(ME)).toHaveLength(1)
    store.update(ME, HASH, { status: 'confirmed', blockNumber: '42' })
    expect(store.get(ME)[0]).toMatchObject({ status: 'confirmed', blockNumber: '42' })
    expect(notified).toBe(2)
    expect(new LocalTxStore(storage).get(ME)[0]?.status).toBe('confirmed')
  })
  test('snapshots are referentially stable until a change (safe for useSyncExternalStore)', () => {
    const store = new LocalTxStore(new MemoryStorage())
    expect(store.get(ME)).toBe(store.get(ME))
    store.add(tx())
    const a = store.get(ME)
    expect(store.get(ME)).toBe(a)
  })
  test('survives corrupt storage and ignores malformed entries', () => {
    const storage = new MemoryStorage()
    storage.setItem(storageKey(ME), '{not json')
    expect(new LocalTxStore(storage).get(ME)).toEqual([])
    storage.setItem(storageKey(ME), JSON.stringify([{ hash: 'nope' }, tx()]))
    expect(new LocalTxStore(storage).get(ME)).toHaveLength(1)
  })
  test('works with no storage at all and caps the list', () => {
    const store = new LocalTxStore(undefined)
    for (let i = 0; i < 60; i++) store.add(tx({ hash: `0x${i.toString(16).padStart(64, '0')}`, createdAt: i }))
    expect(store.get(ME)).toHaveLength(50)
    expect(store.get(ME)[0]?.createdAt).toBe(59)
  })
  test('does not duplicate the same hash and keeps accounts separate', () => {
    const store = new LocalTxStore(new MemoryStorage())
    store.add(tx())
    store.add(tx({ createdAt: 2 }))
    expect(store.get(ME)).toHaveLength(1)
    expect(store.get(OTHER)).toHaveLength(0)
  })
})
