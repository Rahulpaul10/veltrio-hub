import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getAddress, isAddress } from 'viem'
import { getChain, getUsdc } from '@/onchain-facts'
import { NETWORK, buildNetworkConfig, parseContracts, parseDomain, parseRpcUrls, arcMainnet } from '@/config/network'
import { usdcAbi } from '@/abi/usdc'
import abiJson from '../../contracts/abi/USDC.abi.json'

describe('network configuration', () => {
  test('is Arc Mainnet only', () => {
    expect(NETWORK.chainId).toBe(5042)
    expect(NETWORK.chainIdHex).toBe('0x13B2')
    expect(`0x${NETWORK.chainId.toString(16).toUpperCase()}`).toBe(NETWORK.chainIdHex)
    expect(arcMainnet.id).toBe(5042)
    expect(arcMainnet.testnet).toBeFalsy()
    expect(NETWORK.explorerUrl).toBe('https://explorer.arc.io')
    expect(NETWORK.rpcUrls).toContain('https://rpc.mainnet.arc.io')
    expect(arcMainnet.nativeCurrency).toEqual({ name: 'USDC', symbol: 'USDC', decimals: 18 })
  })

  test('USDC is the official 6-decimal ERC-20 interface and matches the registry', () => {
    expect(NETWORK.usdc.address).toBe(getAddress('0x3600000000000000000000000000000000000000'))
    expect(NETWORK.usdc.decimals).toBe(6)
    expect(getUsdc(5042)?.address).toBe(NETWORK.usdc.address)
    expect(getChain(5042)?.isTestnet).toBe(false)
  })

  test('contains no testnet settings', () => {
    const serialized = JSON.stringify({ ...NETWORK, chain: undefined }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) + JSON.stringify(arcMainnet)
    expect(serialized).not.toMatch(/5042002|testnet|sepolia/i)
  })

  test('no testnet chain or URL is referenced by app source', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          if (name === '__tests__') continue
          walk(path)
        } else if (/\.(ts|tsx|css|html)$/.test(name) && !/onchain-facts|tracing|console-capture/.test(name)) {
          const text = readFileSync(path, 'utf8')
          if (/5042002|arcTestnet|testnet\.arc\.io|faucet\.circle/i.test(text)) offenders.push(path)
        }
      }
    }
    walk(join(import.meta.dir, '..'))
    expect(offenders).toEqual([])
  })

  test('RPC env: only https URLs are used, custom ones come first, default stays as fallback', () => {
    const parsed = parseRpcUrls('https://a.example/rpc, http://insecure.example, not a url,https://a.example/rpc/')
    expect(parsed.urls).toEqual(['https://a.example/rpc'])
    expect(parsed.warnings).toHaveLength(2)
    const config = buildNetworkConfig({ VITE_RPC_URLS: 'https://a.example/rpc' })
    expect(config.rpcUrls).toEqual(['https://a.example/rpc', 'https://rpc.mainnet.arc.io'])
    expect(config.chain.id).toBe(5042)
    // Wallets are only ever asked to add the official RPC, never a custom endpoint.
    expect(config.chain.rpcUrls.default.http).toEqual(['https://rpc.mainnet.arc.io'])
  })

  test('domain env is validated', () => {
    expect(parseDomain('https://Wallet.Example.com/')).toMatchObject({ domain: 'Wallet.Example.com', url: 'https://Wallet.Example.com' })
    expect(parseDomain('')).toMatchObject({ domain: '', warnings: [] })
    expect(parseDomain('not a domain').warnings).toHaveLength(1)
    expect(parseDomain('localhost').domain).toBe('')
  })

  test('deployed contracts: empty record is valid, invalid addresses fail loudly', () => {
    expect(NETWORK.contracts).toEqual({})
    expect(parseContracts({ contracts: { Vault: { address: '0x3600000000000000000000000000000000000000' } } })).toEqual({
      Vault: getAddress('0x3600000000000000000000000000000000000000'),
    })
    expect(() => parseContracts({ contracts: { Bad: { address: '0x123' } } })).toThrow()
    expect(() => parseContracts({ contracts: { Missing: {} } })).toThrow()
  })

  test('contracts/abi/USDC.abi.json matches the ABI used by the app', () => {
    expect(abiJson).toEqual(JSON.parse(JSON.stringify(usdcAbi)))
  })
})

describe('custom contract stays separate from official USDC', () => {
  const deployments = JSON.parse(readFileSync(new URL('../../contracts/deployments/arc-mainnet.json', import.meta.url), 'utf8')) as {
    chainId: number
    contracts: Record<string, { address: string }>
  }

  test('the deployment record is for Arc Mainnet and holds no placeholder or USDC address', () => {
    expect(deployments.chainId).toBe(5042)
    for (const [name, entry] of Object.entries(deployments.contracts)) {
      expect(isAddress(entry.address, { strict: false })).toBe(true)
      expect(entry.address.toLowerCase()).not.toBe(NETWORK.usdc.address.toLowerCase())
      expect(entry.address).not.toMatch(/^0x0{40}$/)
      expect(name).not.toMatch(/example|placeholder|todo/i)
    }
  })

  test('nothing is deployed yet, so the live config exposes no custom contract', () => {
    expect(Object.keys(deployments.contracts)).toEqual([])
    expect(Object.keys(NETWORK.contracts)).toEqual([])
  })

  test('the app does not import the unfinished contract or its ABI, and Send still targets only official USDC', () => {
    const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: new URL('..', import.meta.url).pathname })].filter((f) => !f.startsWith('__tests__/'))
    for (const f of files) {
      const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      expect(text).not.toMatch(/Veltrio\.abi|abi\/Veltrio|Veltrio\.sol/)
    }
    expect(readFileSync(new URL('../hooks/useSendTransfer.ts', import.meta.url), 'utf8')).toContain('address: NETWORK.usdc.address')
  })

  test('the Veltrio ABI file exposes only pay, usdc and the Payment event (no admin or custody functions)', () => {
    const abi = JSON.parse(readFileSync(new URL('../../contracts/abi/Veltrio.abi.json', import.meta.url), 'utf8')) as Array<{ type: string; name?: string; stateMutability?: string }>
    const fns = abi.filter((x) => x.type === 'function').map((x) => x.name).sort()
    expect(fns).toEqual(['pay', 'usdc'])
    expect(abi.filter((x) => x.type === 'event').map((x) => x.name)).toEqual(['Payment'])
    expect(abi.some((x) => x.stateMutability === 'payable' || x.type === 'receive' || x.type === 'fallback')).toBe(false)
  })
})
