import type { Address } from 'viem'
import { Amount, gasTokenDecimalsFor, gasTokenToUsdc } from '@/onchain-money'
import { ARC_MAINNET_CHAIN_ID, MIN_MAX_FEE_PER_GAS, NETWORK } from '@/config/network'
import { usdcAbi } from '@/abi/usdc'

/** Extra gas on top of the estimate so a small state change cannot make the transfer run out of gas. */
const GAS_BUFFER_NUMERATOR = 120n
const GAS_BUFFER_DENOMINATOR = 100n
const NATIVE_PER_USDC6 = 10n ** 12n

export interface FeeQuote {
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  /** Worst case fee in native units (18 decimals): gasLimit x maxFeePerGas. Only ever charged up to what is used. */
  maxFeeNative: bigint
  /** Likely fee in native units (18 decimals): gas estimate x (base fee + tip). */
  expectedFeeNative: bigint
  createdAt: number
}

export function buildFeeQuote(input: {
  gasEstimate: bigint
  baseFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  now?: number
}): FeeQuote {
  const { gasEstimate, baseFeePerGas, maxPriorityFeePerGas } = input
  const gasLimit = (gasEstimate * GAS_BUFFER_NUMERATOR + GAS_BUFFER_DENOMINATOR - 1n) / GAS_BUFFER_DENOMINATOR
  // 2x base fee of headroom so the transaction still lands if the base fee moves; unused fee is refunded.
  let maxFeePerGas = baseFeePerGas * 2n + maxPriorityFeePerGas
  if (maxFeePerGas < MIN_MAX_FEE_PER_GAS) maxFeePerGas = MIN_MAX_FEE_PER_GAS
  const effectivePrice = baseFeePerGas + maxPriorityFeePerGas
  return {
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    maxFeeNative: gasLimit * maxFeePerGas,
    expectedFeeNative: gasEstimate * (effectivePrice < maxFeePerGas ? effectivePrice : maxFeePerGas),
    createdAt: input.now ?? Date.now(),
  }
}

/** Native (18-decimal) fee rounded UP to the 6-decimal USDC view, so we never understate a cost. */
export function ceilNativeToUsdc6(native18: bigint): bigint {
  const rounded = Amount.fromRaw(native18 + NATIVE_PER_USDC6 - 1n, gasTokenDecimalsFor(ARC_MAINNET_CHAIN_ID))
  return gasTokenToUsdc(ARC_MAINNET_CHAIN_ID, rounded).raw
}

/**
 * Largest 6-decimal amount that can be sent while still paying the worst-case fee.
 * Both inputs are the same pool of USDC seen in its native (18 decimals) view.
 */
export function maxSpendable6(nativeBalance18: bigint, maxFeeNative18: bigint): bigint {
  const free = nativeBalance18 - maxFeeNative18
  return free > 0n ? free / NATIVE_PER_USDC6 : 0n
}

export interface FeeClient {
  estimateContractGas(args: {
    address: Address
    abi: typeof usdcAbi
    functionName: 'transfer'
    args: readonly [Address, bigint]
    account: Address
  }): Promise<bigint>
  getBlock(): Promise<{ baseFeePerGas: bigint | null }>
  estimateMaxPriorityFeePerGas(): Promise<bigint>
}

export async function fetchTransferFeeQuote(
  client: FeeClient,
  params: { account: Address; to: Address; amountRaw: bigint },
): Promise<FeeQuote> {
  const [gasEstimate, block, tip] = await Promise.all([
    client.estimateContractGas({
      address: NETWORK.usdc.address,
      abi: usdcAbi,
      functionName: 'transfer',
      args: [params.to, params.amountRaw],
      account: params.account,
    }),
    client.getBlock(),
    client.estimateMaxPriorityFeePerGas(),
  ])
  if (block.baseFeePerGas === null) throw new Error('Arc RPC did not return a base fee')
  return buildFeeQuote({ gasEstimate, baseFeePerGas: block.baseFeePerGas, maxPriorityFeePerGas: tip })
}
