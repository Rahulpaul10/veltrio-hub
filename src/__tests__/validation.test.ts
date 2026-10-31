import { describe, expect, test } from 'bun:test'
import { parseAmountInput, validateRecipient, validateTransfer } from '@/lib/validation'
import { buildFeeQuote, ceilNativeToUsdc6, fetchTransferFeeQuote, maxSpendable6, type FeeClient } from '@/lib/fees'
import { formatNativeAsUsdc, formatUsdcAmount, nativeToUsdc6 } from '@/lib/format'

const ME = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const USDC = '0x3600000000000000000000000000000000000000'
const N = 10n ** 12n

describe('recipient validation', () => {
  test('accepts a valid address and normalizes it', () => {
    const r = validateRecipient(OTHER, ME)
    expect(r.ok).toBe(true)
  })
  test('empty is silent, garbage gets a message', () => {
    expect(validateRecipient('  ')).toEqual({ ok: false, error: '' })
    for (const bad of ['0x123', 'hello', '2222222222222222222222222222222222222222', '0xZZ22222222222222222222222222222222222222']) {
      const r = validateRecipient(bad)
      expect(r.ok).toBe(false)
      expect(r.ok ? '' : r.error).not.toBe('')
    }
  })
  test('rejects a bad checksum but allows all-lowercase', () => {
    expect(validateRecipient('0x5B12Ce46C7194aD57d143bC22847224047b1Ef42').ok).toBe(true)
    expect(validateRecipient('0x5b12Ce46C7194aD57d143bC22847224047b1Ef42').ok).toBe(false)
    expect(validateRecipient('0x5b12ce46c7194ad57d143bc22847224047b1ef42').ok).toBe(true)
  })
  test('rejects the zero address, the USDC contract and yourself', () => {
    expect(validateRecipient('0x0000000000000000000000000000000000000000').ok).toBe(false)
    expect(validateRecipient(USDC).ok).toBe(false)
    expect(validateRecipient(ME, ME).ok).toBe(false)
    expect(validateRecipient(ME.toUpperCase().replace('0X', '0x'), ME).ok).toBe(false)
  })
})

describe('amount validation', () => {
  test('parses valid amounts exactly in 6 decimals', () => {
    const a = parseAmountInput('12.5')
    expect(a.ok && a.amount.raw).toBe(12_500_000n)
    const b = parseAmountInput('0.000001')
    expect(b.ok && b.amount.raw).toBe(1n)
    const c = parseAmountInput('5.')
    expect(c.ok && c.amount.raw).toBe(5_000_000n)
  })
  test('rejects empty, zero, negative, junk and >6 decimals', () => {
    expect(parseAmountInput('')).toEqual({ ok: false, error: '' })
    expect(parseAmountInput('0').ok).toBe(false)
    expect(parseAmountInput('0.000000').ok).toBe(false)
    expect(parseAmountInput('-1').ok).toBe(false)
    expect(parseAmountInput('1e3').ok).toBe(false)
    expect(parseAmountInput('abc').ok).toBe(false)
    const tooMany = parseAmountInput('1.0000001')
    expect(tooMany.ok).toBe(false)
    expect(tooMany.ok ? '' : tooMany.error).toContain('6 decimal')
  })
})

describe('transfer validation (balance and gas)', () => {
  const funded = { usdcBalance: 10_000_000n, nativeBalance: 10_000_000n * N }
  const fee = 5_000n * N // 0.005 USDC max fee, 18-decimal

  test('waits for each input in order', () => {
    expect(validateTransfer({ to: '', amount: '', self: ME }).waitingFor).toBe('recipient')
    expect(validateTransfer({ to: OTHER, amount: '', self: ME }).waitingFor).toBe('amount')
    expect(validateTransfer({ to: OTHER, amount: '1', self: ME }).waitingFor).toBe('balance')
    expect(validateTransfer({ to: OTHER, amount: '1', self: ME, ...funded }).waitingFor).toBe('fee')
  })
  test('can review a funded transfer with a fee', () => {
    const r = validateTransfer({ to: OTHER, amount: '1', self: ME, ...funded, maxFeeNative: fee })
    expect(r.canReview).toBe(true)
    expect(r.amountRaw).toBe(1_000_000n)
  })
  test('blocks an amount above the balance', () => {
    const r = validateTransfer({ to: OTHER, amount: '10.000001', self: ME, ...funded, maxFeeNative: fee })
    expect(r.canReview).toBe(false)
    expect(r.amountError).toContain('more than your balance')
  })
  test('blocks sending the whole balance when the fee cannot be paid (USDC is gas)', () => {
    const r = validateTransfer({ to: OTHER, amount: '10', self: ME, ...funded, maxFeeNative: fee })
    expect(r.canReview).toBe(false)
    expect(r.fundsError).toContain('network fee')
  })
  test('allows the largest amount that still pays the fee', () => {
    const max = maxSpendable6(funded.nativeBalance, fee)
    expect(max).toBe(9_995_000n)
    const ok = validateTransfer({ to: OTHER, amount: '9.995', self: ME, ...funded, maxFeeNative: fee })
    expect(ok.canReview).toBe(true)
    const over = validateTransfer({ to: OTHER, amount: '9.995001', self: ME, ...funded, maxFeeNative: fee })
    expect(over.canReview).toBe(false)
  })
  test('zero balance can never send', () => {
    const r = validateTransfer({ to: OTHER, amount: '0.01', self: ME, usdcBalance: 0n, nativeBalance: 0n, maxFeeNative: fee })
    expect(r.canReview).toBe(false)
  })
})

describe('fees', () => {
  const GWEI = 10n ** 9n
  test('enforces the 20 gwei maxFeePerGas floor', () => {
    const q = buildFeeQuote({ gasEstimate: 65_000n, baseFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 0n })
    expect(q.maxFeePerGas).toBe(20n * GWEI)
  })
  test('adds 2x base fee headroom, a 20% gas buffer, and orders expected <= max', () => {
    const q = buildFeeQuote({ gasEstimate: 65_000n, baseFeePerGas: 20n * GWEI, maxPriorityFeePerGas: 5n * GWEI })
    expect(q.maxFeePerGas).toBe(45n * GWEI)
    expect(q.gasLimit).toBe(78_000n)
    expect(q.expectedFeeNative).toBe(65_000n * 25n * GWEI)
    expect(q.maxFeeNative).toBe(78_000n * 45n * GWEI)
    expect(q.expectedFeeNative <= q.maxFeeNative).toBe(true)
  })
  test('converts fees between the 18- and 6-decimal views, rounding up for display', () => {
    expect(ceilNativeToUsdc6(1n)).toBe(1n)
    expect(ceilNativeToUsdc6(N)).toBe(1n)
    expect(ceilNativeToUsdc6(N + 1n)).toBe(2n)
    expect(nativeToUsdc6(N * 5n + 7n)).toBe(5n)
  })
  test('fetchTransferFeeQuote combines gas, base fee and tip, and fails without a base fee', async () => {
    const base: FeeClient = {
      estimateContractGas: () => Promise.resolve(65_000n),
      getBlock: () => Promise.resolve({ baseFeePerGas: 20n * GWEI }),
      estimateMaxPriorityFeePerGas: () => Promise.resolve(5n * GWEI),
    }
    const q = await fetchTransferFeeQuote(base, { account: ME, to: OTHER, amountRaw: 1n })
    expect(q.gasLimit).toBe(78_000n)
    await expect(
      fetchTransferFeeQuote({ ...base, getBlock: () => Promise.resolve({ baseFeePerGas: null }) }, { account: ME, to: OTHER, amountRaw: 1n }),
    ).rejects.toThrow()
    await expect(
      fetchTransferFeeQuote({ ...base, estimateContractGas: () => Promise.reject(new Error('execution reverted')) }, { account: ME, to: OTHER, amountRaw: 1n }),
    ).rejects.toThrow('reverted')
  })
})

describe('formatting', () => {
  test('formats 6-decimal amounts exactly', () => {
    expect(formatUsdcAmount(0n)).toBe('0.00')
    expect(formatUsdcAmount(1_234_567_890_000n)).toBe('1,234,567.89')
    expect(formatUsdcAmount(1n, 6)).toBe('0.000001')
    expect(formatUsdcAmount(12_345_678n)).toBe('12.345678')
  })
  test('shows dust honestly instead of 0.00', () => {
    expect(formatNativeAsUsdc(5n * N)).toBe('0.000005')
    expect(formatNativeAsUsdc(123n)).toBe('<0.000001')
    expect(formatNativeAsUsdc(0n)).toBe('0.00')
  })
})

import { normalizeAmountInput } from '@/lib/validation'

describe('amount field normalization never guesses a different number', () => {
  test('plain numbers and a lone decimal comma', () => {
    expect(normalizeAmountInput('12.5')).toBe('12.5')
    expect(normalizeAmountInput('1,5')).toBe('1.5')
    expect(normalizeAmountInput('0,25')).toBe('0.25')
    expect(normalizeAmountInput('1,')).toBe('1.')
    expect(normalizeAmountInput('abc12$.5')).toBe('12.5')
  })
  test('properly grouped thousands separators are removed (regression: "1,000.50" used to become 1.0005)', () => {
    expect(normalizeAmountInput('1,000.50')).toBe('1000.50')
    expect(normalizeAmountInput('1,234,567.89')).toBe('1234567.89')
    expect(normalizeAmountInput('1,000,000')).toBe('1000000')
  })
  test('ambiguous or malformed input is kept as typed so validation can reject it', () => {
    expect(normalizeAmountInput('1,000')).toBe('1,000')
    expect(normalizeAmountInput('12,345')).toBe('12,345')
    expect(normalizeAmountInput('1,00,000.5')).toBe('1,00,000.5')
    expect(normalizeAmountInput('1.234.567,89')).toBe('1.234.567,89')
    expect(normalizeAmountInput('1.2.3')).toBe('1.2.3')
  })
  test('parseAmountInput refuses anything with a comma and malformed dots', () => {
    for (const bad of ['1,000', '1,00,000.5', '1.234.567,89', '1.2.3']) {
      const r = parseAmountInput(bad)
      expect(r.ok).toBe(false)
    }
    const comma = parseAmountInput('1,000')
    expect(comma.ok ? '' : comma.error).toContain('dot')
    const r = parseAmountInput(normalizeAmountInput('1,000.50'))
    expect(r.ok && r.amount.raw).toBe(1_000_500_000n)
  })
})
