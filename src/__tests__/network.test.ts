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

  test('the Veltrio ABI takes exactly one constructor argument (initialOwner), limits the owner to pause/rescue/ownership, and has no payable or fee surface', () => {
    const abi = JSON.parse(readFileSync(new URL('../../contracts/abi/Veltrio.abi.json', import.meta.url), 'utf8')) as Array<{ type: string; name?: string; stateMutability?: string; inputs?: Array<{ name: string; type: string }> }>
    const ctor = abi.filter((x) => x.type === 'constructor')
    expect(ctor).toHaveLength(1)
    expect(ctor[0]?.inputs?.map((i) => `${i.name}:${i.type}`)).toEqual(['initialOwner:address'])
    const fns = abi.filter((x) => x.type === 'function').map((x) => x.name).sort()
    expect(fns).toEqual([
      'ARC_MAINNET_CHAIN_ID', 'MAX_PAUSE_DURATION', 'PAUSE_COOLDOWN', 'USDC', 'USDC_DECIMALS', 'acceptOwnership', 'owner', 'pause',
      'pauseLockedUntil', 'paused', 'pausedAt', 'pay', 'pendingOwner', 'renounceOwnership', 'rescueNative', 'rescueToken',
      'transferOwnership', 'unpause',
    ])
    expect(abi.some((x) => x.stateMutability === 'payable' || x.type === 'receive' || x.type === 'fallback')).toBe(false)
    expect(fns.some((n) => /fee|upgrade|mint|burn|withdraw|sweep|setUsdc|setToken/i.test(n ?? ''))).toBe(false)
  })

  test('the planned owner is a valid checksummed address, recorded once in the mainnet file and matching the docs, and is not a deployed contract entry', () => {
    const dep = deployments as unknown as { plannedConstructorArgs: { initialOwner: string }; contracts: Record<string, unknown> }
    const owner = dep.plannedConstructorArgs.initialOwner
    expect(isAddress(owner, { strict: true })).toBe(true)
    expect(owner).not.toBe(NETWORK.usdc.address)
    expect(Object.keys(dep.contracts)).toEqual([])
    for (const f of ['../../contracts/README.md', '../../docs/DEPLOYMENT.md']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).toContain(owner)
    }
    expect(readFileSync(new URL('../../contracts/Veltrio.sol', import.meta.url), 'utf8').toLowerCase()).not.toContain(owner.toLowerCase())
    expect(readFileSync(new URL('../config/network.ts', import.meta.url), 'utf8').toLowerCase()).not.toContain(owner.toLowerCase())
  })

  test('Veltrio.sol stays under 500 lines of code, imports OpenZeppelin, pins solc 0.8.28 and contains no secrets', () => {
    const lines = readFileSync(new URL('../../contracts/Veltrio.sol', import.meta.url), 'utf8').split('\n')
    const code = lines.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && l.trim() !== '')
    expect(lines.length).toBeLessThan(500)
    expect(code.length).toBeLessThan(500)
    const text = lines.join('\n')
    expect(text).toContain('pragma solidity 0.8.28;')
    expect(text).toContain('@openzeppelin/contracts/')
    expect(text).not.toMatch(/PRIVATE_KEY|mnemonic|seed phrase|0x[0-9a-fA-F]{64}/i)
  })

  test("Veltrio.sol hard-codes exactly the app's verified Arc Mainnet chain id, USDC address and 6 decimals", () => {
    const src = readFileSync(new URL('../../contracts/Veltrio.sol', import.meta.url), 'utf8')
    expect(src).toContain(`address public constant USDC = ${NETWORK.usdc.address};`)
    expect(src).toContain(`uint256 public constant ARC_MAINNET_CHAIN_ID = ${NETWORK.chainId};`)
    expect(src).toContain(`uint8 public constant USDC_DECIMALS = ${NETWORK.usdc.decimals};`)
    expect(src).not.toMatch(/5042002/)
  })

  test('the Arc Testnet deployment record is separate, labelled testnet, and never mixed into the mainnet file or app config', () => {
    const testnet = JSON.parse(readFileSync(new URL('../../contracts/deployments/arc-testnet.json', import.meta.url), 'utf8')) as { chainId: number; label: string; contracts: Record<string, { address: string }> }
    expect(testnet.chainId).toBe(5042002)
    expect(testnet.label).toMatch(/TESTNET/)
    const mainnetText = readFileSync(new URL('../../contracts/deployments/arc-mainnet.json', import.meta.url), 'utf8').toLowerCase()
    const appText = readFileSync(new URL('../config/network.ts', import.meta.url), 'utf8').toLowerCase()
    for (const c of Object.values(testnet.contracts)) {
      expect(mainnetText).not.toContain(c.address.toLowerCase())
      expect(appText).not.toContain(c.address.toLowerCase())
    }
  })
  test('docs pin OpenZeppelin 5.6.1 exactly, explain the missing Unpaused event on expiry, and the audit/integration status', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    expect({ ...pkg.dependencies, ...pkg.devDependencies }['@openzeppelin/contracts']).toBe('5.6.1')
    for (const f of ['../../contracts/README.md', '../../docs/DEPLOYMENT.md']) {
      const text = readFileSync(new URL(f, import.meta.url), 'utf8')
      expect(text).toContain('5.6.1')
      expect(text).toMatch(/no `Unpaused` event/i)
      expect(text).toContain('paused()')
      expect(text).toMatch(/not (independently )?audited/i)
    }
    expect(readFileSync(new URL('../../contracts/README.md', import.meta.url), 'utf8')).toMatch(/not integrated with the app/i)
  })

  test('public/vercel.json is valid, rewrites deep links but not /assets, and sends the security headers', () => {
    const cfg = JSON.parse(readFileSync(new URL('../../public/vercel.json', import.meta.url), 'utf8')) as {
      rewrites: Array<{ source: string; destination: string }>
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>
    }
    const rw = cfg.rewrites[0]!
    expect(rw.destination).toBe('/index.html')
    const re = new RegExp(`^${rw.source}$`)
    for (const path of ['/send', '/receive', '/activity', '/nope/deep', '/']) expect(re.test(path)).toBe(true)
    expect(re.test('/assets/index-abc.js')).toBe(false)
    const keys = (cfg.headers.find((h) => h.source === '/(.*)')?.headers ?? []).map((h) => h.key)
    for (const k of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Permissions-Policy', 'Strict-Transport-Security']) expect(keys).toContain(k)
    expect(JSON.stringify(cfg)).not.toMatch(/5042002|testnet|PRIVATE|secret/i)
  })
})
