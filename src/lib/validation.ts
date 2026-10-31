import { getAddress, isAddress, zeroAddress, type Address } from 'viem'
import { Amount, AmountError, parseAmount, usdcToGasToken } from '@/onchain-money'
import { ARC_MAINNET_CHAIN_ID, NETWORK } from '@/config/network'
import { formatUsdcAmount } from '@/lib/format'
import { ceilNativeToUsdc6 } from '@/lib/fees'

export type RecipientResult = { ok: true; address: Address } | { ok: false; error: string }

export function validateRecipient(input: string, self?: Address): RecipientResult {
  const value = input.trim()
  if (!value) return { ok: false, error: '' }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return { ok: false, error: 'Enter a full wallet address that starts with 0x (42 characters).' }
  }
  // Mixed-case addresses carry a checksum; a wrong one usually means a typo.
  if (!isAddress(value, { strict: true })) return { ok: false, error: 'This address has a typo (checksum mismatch). Check it and try again.' }
  const address = getAddress(value)
  if (address === zeroAddress) return { ok: false, error: 'The zero address cannot receive funds.' }
  if (address.toLowerCase() === NETWORK.usdc.address.toLowerCase()) {
    return { ok: false, error: 'This is the USDC contract address. Funds sent here would be lost.' }
  }
  if (self && address.toLowerCase() === self.toLowerCase()) {
    return { ok: false, error: 'This is your own address. Enter a different recipient.' }
  }
  return { ok: true, address }
}

/**
 * Cleans what is typed or pasted into the amount field without ever guessing a different number.
 * Letters and symbols are dropped. A lone decimal comma becomes a dot ("1,5" -> "1.5"). Proper thousands
 * separators are removed ("1,000.50" -> "1000.50"). Anything ambiguous ("1,000": one thousand or one?) or
 * malformed is left as typed so validation can ask the user, instead of silently changing the amount.
 */
export function normalizeAmountInput(raw: string): string {
  const s = raw.replace(/[^0-9.,]/g, '')
  if (!s.includes(',')) return s
  const grouped = /^\d{1,3}(,\d{3})+$/
  const dotIndex = s.indexOf('.')
  if (dotIndex !== -1) {
    const whole = s.slice(0, dotIndex)
    return grouped.test(whole) ? whole.replace(/,/g, '') + s.slice(dotIndex) : s
  }
  const parts = s.split(',')
  if (parts.length === 2) {
    const [a = '', b = ''] = parts
    if (b.length === 3 && a.length >= 1 && a.length <= 3) return s
    return `${a}.${b}`
  }
  return grouped.test(s) ? s.replace(/,/g, '') : s
}

export type AmountResult = { ok: true; amount: Amount } | { ok: false; error: string }

export function parseAmountInput(input: string): AmountResult {
  const value = input.trim()
  if (!value) return { ok: false, error: '' }
  if (value.includes(',')) return { ok: false, error: 'Use a dot for decimals and no thousands separators, for example 1000.50.' }
  try {
    const amount = parseAmount(ARC_MAINNET_CHAIN_ID, value)
    if (amount.isNegative() || amount.isZero()) return { ok: false, error: 'Enter an amount greater than 0.' }
    return { ok: true, amount }
  } catch (error) {
    if (error instanceof AmountError) {
      if (error.code === 'TOO_MANY_FRACTION_DIGITS') return { ok: false, error: 'USDC supports up to 6 decimal places.' }
      return { ok: false, error: 'Enter a valid number, for example 12.50.' }
    }
    throw error
  }
}

export interface TransferCheckInput {
  to: string
  amount: string
  self?: Address
  /** ERC-20 view, 6 decimals. Undefined while loading or when the read failed. */
  usdcBalance?: bigint
  /** Native view of the same pool, 18 decimals. */
  nativeBalance?: bigint
  /** Worst-case network fee, 18 decimals. */
  maxFeeNative?: bigint
}

export interface TransferCheck {
  toError?: string
  amountError?: string
  /** Balance can't cover amount plus the network fee. */
  fundsError?: string
  /** What is still missing before the form can be reviewed. */
  waitingFor?: 'recipient' | 'amount' | 'balance' | 'fee'
  canReview: boolean
  recipient?: Address
  amountRaw?: bigint
}

export function validateTransfer(input: TransferCheckInput): TransferCheck {
  const recipient = validateRecipient(input.to, input.self)
  const amount = parseAmountInput(input.amount)
  const result: TransferCheck = { canReview: false }

  if (!recipient.ok && recipient.error) result.toError = recipient.error
  if (!amount.ok && amount.error) result.amountError = amount.error
  if (!recipient.ok) {
    result.waitingFor = 'recipient'
    return result
  }
  result.recipient = recipient.address
  if (!amount.ok) {
    result.waitingFor = 'amount'
    return result
  }
  result.amountRaw = amount.amount.raw

  if (input.usdcBalance === undefined || input.nativeBalance === undefined) {
    result.waitingFor = 'balance'
    return result
  }
  if (amount.amount.raw > input.usdcBalance) {
    result.amountError = `That is more than your balance of ${formatUsdcAmount(input.usdcBalance)} USDC.`
    return result
  }
  if (input.maxFeeNative === undefined) {
    result.waitingFor = 'fee'
    return result
  }
  const amountNative = usdcToGasToken(ARC_MAINNET_CHAIN_ID, amount.amount).raw
  if (amountNative + input.maxFeeNative > input.nativeBalance) {
    result.fundsError = `Not enough USDC to cover the network fee as well (up to ${formatUsdcAmount(ceilNativeToUsdc6(input.maxFeeNative), 6)} USDC). Lower the amount.`
    return result
  }
  result.canReview = true
  return result
}
