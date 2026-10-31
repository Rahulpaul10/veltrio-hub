/**
 * Veltrio central network configuration.
 *
 * This is the one file to edit when you change the site domain, RPC endpoints,
 * token addresses or deployed contract addresses. Production is Arc Mainnet only:
 * the chain id, explorer and USDC contract are fixed here on purpose so a typo in
 * an environment variable can never silently move the app to another network.
 *
 * Things you can change without touching code (see README.md, Environment variables):
 *   VITE_SITE_DOMAIN  your own domain, e.g. wallet.example.com
 *   VITE_RPC_URLS     extra https RPC endpoints, tried before the default one
 *
 * Deployed contract addresses live in contracts/deployments/arc-mainnet.json.
 */

import { defineChain, isAddress, getAddress, type Address, type Chain } from 'viem'
import { getUsdc, requireChain } from '@/onchain-facts'
import deployments from '../../contracts/deployments/arc-mainnet.json'

export const ARC_MAINNET_CHAIN_ID = 5042 as const
export const ARC_MAINNET_CHAIN_ID_HEX = '0x13B2' as const

/** Arc's native USDC system emitter (EIP-7708). Logs every USDC movement at 18 decimals. */
export const NATIVE_USDC_EMITTER: Address = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE'

/** The mempool rejects a maxFeePerGas below this (Arc docs: "Gas and fees"). */
export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n

export interface RawEnv {
  VITE_SITE_DOMAIN?: string
  VITE_RPC_URLS?: string
}

export interface NetworkConfig {
  site: { name: string; domain: string; url: string }
  chain: Chain
  chainId: typeof ARC_MAINNET_CHAIN_ID
  chainIdHex: typeof ARC_MAINNET_CHAIN_ID_HEX
  explorerUrl: string
  rpcUrls: string[]
  usdc: { symbol: 'USDC'; address: Address; decimals: number }
  contracts: Record<string, Address>
  /** Problems found in the environment. Shown in the UI, never silently ignored. */
  warnings: string[]
}

/** Accepts only https URLs. Anything else is reported, not used. */
export function parseRpcUrls(raw: string | undefined): { urls: string[]; warnings: string[] } {
  const urls: string[] = []
  const warnings: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const value = part.trim()
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:') throw new Error('not https')
      const clean = url.toString().replace(/\/$/, '')
      if (!urls.includes(clean)) urls.push(clean)
    } catch {
      warnings.push(`Ignored invalid RPC URL in VITE_RPC_URLS (must be https): ${value}`)
    }
  }
  return { urls, warnings }
}

export function parseDomain(raw: string | undefined): { domain: string; url: string; warnings: string[] } {
  const value = (raw ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!value) return { domain: '', url: '', warnings: [] }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/i.test(value)) {
    return { domain: '', url: '', warnings: [`Ignored invalid VITE_SITE_DOMAIN: ${value}`] }
  }
  return { domain: value, url: `https://${value}`, warnings: [] }
}

export function parseContracts(record: { contracts?: Record<string, { address?: string }> }): Record<string, Address> {
  const out: Record<string, Address> = {}
  for (const [name, entry] of Object.entries(record.contracts ?? {})) {
    const address = entry?.address
    if (!address || !isAddress(address)) {
      throw new Error(`contracts/deployments/arc-mainnet.json: "${name}" has no valid address`)
    }
    out[name] = getAddress(address)
  }
  return out
}

export function buildNetworkConfig(env: RawEnv): NetworkConfig {
  // Fixed Arc Mainnet facts, read from the registry and asserted so a bad edit fails loudly.
  const facts = requireChain(ARC_MAINNET_CHAIN_ID)
  const usdcFact = getUsdc(ARC_MAINNET_CHAIN_ID)
  if (facts.isTestnet || facts.chainId !== ARC_MAINNET_CHAIN_ID) {
    throw new Error('Veltrio is Arc Mainnet only: registry entry for chain 5042 is not mainnet')
  }
  if (!usdcFact || usdcFact.decimals !== 6) {
    throw new Error('Arc Mainnet USDC (6 decimals ERC-20 interface) is missing from the registry')
  }

  const rpc = parseRpcUrls(env.VITE_RPC_URLS)
  const site = parseDomain(env.VITE_SITE_DOMAIN)
  const rpcUrls = [...rpc.urls, ...facts.rpcUrls.filter((u) => !rpc.urls.includes(u))]

  const chain = defineChain({
    id: ARC_MAINNET_CHAIN_ID,
    name: 'Arc Mainnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: facts.nativeCurrency.decimals },
    // The chain definition is what a wallet is asked to add, so it lists only the official RPC. Custom
    // endpoints from VITE_RPC_URLS are used by this app's own reads only and are never pushed into wallets.
    rpcUrls: { default: { http: facts.rpcUrls } },
    blockExplorers: { default: { name: 'Arc Explorer', url: facts.explorerBase } },
  })

  return {
    site: { name: 'Veltrio', domain: site.domain, url: site.url },
    chain,
    chainId: ARC_MAINNET_CHAIN_ID,
    chainIdHex: ARC_MAINNET_CHAIN_ID_HEX,
    explorerUrl: facts.explorerBase,
    rpcUrls,
    usdc: { symbol: 'USDC', address: getAddress(usdcFact.address), decimals: usdcFact.decimals },
    contracts: parseContracts(deployments),
    warnings: [...rpc.warnings, ...site.warnings],
  }
}

export const NETWORK: NetworkConfig = buildNetworkConfig(import.meta.env)

export const arcMainnet: Chain = NETWORK.chain

export const explorerTxUrl = (hash: string) => `${NETWORK.explorerUrl}/tx/${hash}`
export const explorerAddressUrl = (address: string) => `${NETWORK.explorerUrl}/address/${address}`
