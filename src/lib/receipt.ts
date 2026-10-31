import type { Hex } from 'viem'
import { NETWORK } from '@/config/network'
import { TRANSFER_TOPIC } from '@/lib/history'
import type { LocalTx } from '@/lib/txStore'

/** Pending transactions older than this are polled slowly: they were probably replaced or dropped. */
export const SLOW_POLL_AFTER_MS = 10 * 60 * 1000
export const SLOW_POLL_GAP_MS = 30_000

/** Whether the receipt watcher should look at a pending transaction now. */
export function shouldCheckReceipt(createdAt: number, lastCheckedAt: number | undefined, now: number): boolean {
  if (now - createdAt <= SLOW_POLL_AFTER_MS) return true
  return lastCheckedAt === undefined || now - lastCheckedAt >= SLOW_POLL_GAP_MS
}

export type ReceiptVerdict = 'confirmed' | 'reverted' | 'unverified'

export interface ReceiptLike {
  status: 'success' | 'reverted'
  transactionHash: Hex
  logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }>
}

const topicAddress = (topic: Hex | undefined) => (topic ? `0x${topic.slice(26)}`.toLowerCase() : '')

/**
 * Decides what a receipt proves about a transfer this app submitted.
 *  - reverted:   the transaction is on-chain and failed. No USDC moved.
 *  - confirmed:  success AND the official USDC contract logged exactly the transfer we asked for
 *                (sender, recipient, amount). Only this verdict may be shown as success.
 *  - unverified: included successfully but we cannot match the expected USDC transfer
 *                (wrong hash, or no matching log). Never shown as success.
 */
export function verifyTransferReceipt(receipt: ReceiptLike, tx: Pick<LocalTx, 'hash' | 'from' | 'to' | 'amountRaw'>): ReceiptVerdict {
  if (receipt.transactionHash.toLowerCase() !== tx.hash.toLowerCase()) return 'unverified'
  if (receipt.status !== 'success') return 'reverted'
  const usdc = NETWORK.usdc.address.toLowerCase()
  const matched = receipt.logs.some(
    (log) =>
      log.address.toLowerCase() === usdc &&
      log.topics.length === 3 &&
      log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      topicAddress(log.topics[1]) === tx.from.toLowerCase() &&
      topicAddress(log.topics[2]) === tx.to.toLowerCase() &&
      log.data !== '0x' &&
      BigInt(log.data) === BigInt(tx.amountRaw),
  )
  return matched ? 'confirmed' : 'unverified'
}
