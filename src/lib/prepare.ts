import type { Address, PublicClient } from 'viem'
import { ARC_MAINNET_CHAIN_ID, NETWORK } from '@/config/network'
import { usdcAbi } from '@/abi/usdc'
import { Amount, usdcDecimalsFor, usdcToGasToken } from '@/onchain-money'
import { fetchTransferFeeQuote, type FeeQuote } from '@/lib/fees'
import { formatUsdcAmount } from '@/lib/format'
import { ceilNativeToUsdc6 } from '@/lib/fees'

/**
 * Freshness rules for the data that authorizes a transfer. Data younger than these limits is used as is, so
 * Confirm reaches the wallet without any network round trip. Older data is re-read (in parallel) first.
 */
export const QUOTE_MAX_AGE_MS = 30_000
export const BALANCE_MAX_AGE_MS = 30_000
/** Mutable only so tests can shorten it. */
export const PREPARE = { refreshTimeoutMs: 10_000 }
/** A refreshed worst-case fee above shown * 110% sends the user back to review instead of the wallet. */
const FEE_JUMP_NUM = 110n
const FEE_JUMP_DEN = 100n

export class PrepareTimeoutError extends Error {
  constructor(ms: number) {
    super(`Refreshing the fee and balance took longer than ${ms} ms`)
    this.name = 'PrepareTimeoutError'
  }
}

export function needsRefresh(input: { quoteCreatedAt: number; balancesUpdatedAt: number; now: number }): boolean {
  const { quoteCreatedAt, balancesUpdatedAt, now } = input
  if (!quoteCreatedAt || !balancesUpdatedAt) return true
  return now - quoteCreatedAt > QUOTE_MAX_AGE_MS || now - balancesUpdatedAt > BALANCE_MAX_AGE_MS
}

export interface FreshInputs {
  quote: FeeQuote
  usdc: bigint
  native: bigint
}

/** Fee quote, USDC balance and native balance read in parallel, with an overall deadline. */
export async function refreshInputs(
  client: PublicClient,
  params: { account: Address; to: Address; amountRaw: bigint },
  timeoutMs: number = PREPARE.refreshTimeoutMs,
): Promise<FreshInputs> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PrepareTimeoutError(timeoutMs)), timeoutMs)
  })
  try {
    const [quote, usdc, native] = await Promise.race([
      Promise.all([
        fetchTransferFeeQuote(client, params),
        client.readContract({ address: NETWORK.usdc.address, abi: usdcAbi, functionName: 'balanceOf', args: [params.account] }),
        client.getBalance({ address: params.account }),
      ]),
      deadline,
    ])
    return { quote, usdc, native }
  } finally {
    clearTimeout(timer)
  }
}

export type PrepareDecision = { ok: true; quote: FeeQuote } | { ok: false; kind: 'funds' | 'fee-changed'; message: string }

/** Re-validates a transfer against freshly read data. Nothing is sent when this says no. */
export function decidePrepared(fresh: FreshInputs, params: { amountRaw: bigint; shownMaxFeeNative: bigint }): PrepareDecision {
  const { quote, usdc, native } = fresh
  if (params.amountRaw > usdc) {
    return { ok: false, kind: 'funds', message: `Your balance is now ${formatUsdcAmount(usdc)} USDC, which is less than this transfer. Nothing was sent.` }
  }
  const amountNative = usdcToGasToken(ARC_MAINNET_CHAIN_ID, Amount.fromRaw(params.amountRaw, usdcDecimalsFor(ARC_MAINNET_CHAIN_ID))).raw
  if (amountNative + quote.maxFeeNative > native) {
    return { ok: false, kind: 'funds', message: 'Your balance no longer covers the amount plus the network fee. Nothing was sent.' }
  }
  if (quote.maxFeeNative * FEE_JUMP_DEN > params.shownMaxFeeNative * FEE_JUMP_NUM) {
    return {
      ok: false,
      kind: 'fee-changed',
      message: `The network fee changed to up to ${formatUsdcAmount(ceilNativeToUsdc6(quote.maxFeeNative), 6)} USDC. Review the transfer again. Nothing was sent.`,
    }
  }
  return { ok: true, quote }
}
