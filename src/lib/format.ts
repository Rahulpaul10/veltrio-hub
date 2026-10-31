import { Amount, formatUnitsExact, gasTokenDecimalsFor, gasTokenToUsdc } from '@/onchain-money'
import { ARC_MAINNET_CHAIN_ID } from '@/config/network'

export function formatAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address
  return `${address.slice(0, head)}…${address.slice(-tail)}`
}

/** Formats a 6-decimal USDC amount exactly, with at least `minFraction` digits and thousands separators. */
export function formatUsdcAmount(raw6: bigint, minFraction = 2): string {
  const exact = formatUnitsExact(raw6, 6)
  const negative = exact.startsWith('-')
  const [whole = '0', fraction = ''] = exact.replace('-', '').split('.')
  const grouped = BigInt(whole).toLocaleString('en-US')
  return `${negative ? '-' : ''}${grouped}.${fraction.padEnd(minFraction, '0')}`
}

/** Native (18-decimal) USDC to the 6-decimal view, truncated. Returns 0n for dust below 0.000001. */
export function nativeToUsdc6(native18: bigint): bigint {
  return gasTokenToUsdc(ARC_MAINNET_CHAIN_ID, Amount.fromRaw(native18, gasTokenDecimalsFor(ARC_MAINNET_CHAIN_ID))).raw
}

/** Display for a native-unit movement; shows "<0.000001" instead of a misleading 0.00 for dust. */
export function formatNativeAsUsdc(native18: bigint): string {
  const raw6 = nativeToUsdc6(native18)
  if (raw6 === 0n && native18 > 0n) return '<0.000001'
  return formatUsdcAmount(raw6)
}

export function formatDateTime(unixSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(unixSeconds * 1000))
}

export function formatRelative(unixSeconds: number, nowMs = Date.now()): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000 - unixSeconds))
  if (diff < 60) return 'Just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86_400) return `${Math.floor(diff / 3600)} h ago`
  return formatDateTime(unixSeconds)
}
