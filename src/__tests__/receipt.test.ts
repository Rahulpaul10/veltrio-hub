import { describe, expect, test } from 'bun:test'
import { verifyTransferReceipt, type ReceiptLike } from '@/lib/receipt'
import { TRANSFER_TOPIC } from '@/lib/history'
import type { Hex } from 'viem'

const USDC = '0x3600000000000000000000000000000000000000'
const SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe'
const FROM = '0xad5eea00214715cce97cdc4d0d13e9ee2b57eace'
const TO = '0xc2eedf3bc7f93366c00c6074df0e6f122fa2445c'
const HASH = '0x938b4e1c094129ced2ce1eed4979fecb9e82eb9ee14ac8e3fd6731b23a7adb9a' as Hex
const pad = (a: string) => `0x${a.replace('0x', '').padStart(64, '0')}` as Hex
// Shape observed in a real Arc Mainnet receipt (read-only lookup): the USDC contract logs a 3-topic
// Transfer with a 6-decimal value, next to the system emitter's 18-decimal log.
const VALUE = 0x1d6c91598n
const tx = { hash: HASH, from: FROM as `0x${string}`, to: TO as `0x${string}`, amountRaw: VALUE.toString() }
const erc20Log = { address: USDC, topics: [TRANSFER_TOPIC, pad(FROM), pad(TO)] as Hex[], data: `0x${VALUE.toString(16).padStart(64, '0')}` as Hex }
const receipt = (over: Partial<ReceiptLike> = {}): ReceiptLike => ({ status: 'success', transactionHash: HASH, logs: [erc20Log], ...over })

describe('receipt verification', () => {
  test('success with the exact USDC transfer is confirmed', () => {
    expect(verifyTransferReceipt(receipt(), tx)).toBe('confirmed')
  })
  test('a reverted receipt is reverted even if it carries a matching log', () => {
    expect(verifyTransferReceipt(receipt({ status: 'reverted' }), tx)).toBe('reverted')
    expect(verifyTransferReceipt(receipt({ status: 'reverted', logs: [] }), tx)).toBe('reverted')
  })
  test('success without a matching log is unverified, never confirmed', () => {
    expect(verifyTransferReceipt(receipt({ logs: [] }), tx)).toBe('unverified')
    expect(verifyTransferReceipt(receipt({ logs: [{ ...erc20Log, data: '0x01' }] }), tx)).toBe('unverified')
    expect(verifyTransferReceipt(receipt({ logs: [{ ...erc20Log, topics: [TRANSFER_TOPIC, pad(FROM), pad(FROM)] }] }), tx)).toBe('unverified')
    expect(verifyTransferReceipt(receipt({ logs: [{ ...erc20Log, topics: [TRANSFER_TOPIC, pad(TO), pad(TO)] }] }), tx)).toBe('unverified')
  })
  test('a matching log from another contract does not count', () => {
    expect(verifyTransferReceipt(receipt({ logs: [{ ...erc20Log, address: '0x4857db576ee0e45f10525ec59527bfd10beec60b' }] }), tx)).toBe('unverified')
    expect(verifyTransferReceipt(receipt({ logs: [{ ...erc20Log, address: SYSTEM }] }), tx)).toBe('unverified')
  })
  test('a receipt for a different hash is unverified', () => {
    expect(verifyTransferReceipt(receipt({ transactionHash: `0x${'00'.repeat(32)}` }), tx)).toBe('unverified')
  })
})

import { SLOW_POLL_AFTER_MS, SLOW_POLL_GAP_MS, shouldCheckReceipt } from '@/lib/receipt'

describe('receipt polling backoff', () => {
  const now = 10_000_000
  test('fresh pending transactions are checked on every tick', () => {
    expect(shouldCheckReceipt(now - 5_000, now - 2_500, now)).toBe(true)
    expect(shouldCheckReceipt(now - SLOW_POLL_AFTER_MS, now - 100, now)).toBe(true)
  })
  test('old pending transactions (likely dropped) are polled at most every 30 seconds', () => {
    const created = now - SLOW_POLL_AFTER_MS - 1
    expect(shouldCheckReceipt(created, undefined, now)).toBe(true)
    expect(shouldCheckReceipt(created, now - 2_500, now)).toBe(false)
    expect(shouldCheckReceipt(created, now - SLOW_POLL_GAP_MS, now)).toBe(true)
  })
})
