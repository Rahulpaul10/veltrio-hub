/**
 * Post-build guard: the production bundle in dist/ must be Arc Mainnet only.
 * Run with `bun run verify:build` after `bun run build` (Netlify runs it too).
 * Exits non-zero with a list of problems, so a bad build never gets published.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist', import.meta.url))

const FORBIDDEN: Array<[RegExp, string]> = [
  [/5042002|0x4cef52/i, 'Arc Testnet chain id'],
  [/testnet\.arc\.io/i, 'Arc Testnet RPC or explorer URL'],
  [/ARC-TESTNET|arcTestnet|Arc Testnet/, 'Arc Testnet name'],
  [/sepolia|\bgoerli\b|\bholesky\b/i, 'other testnet name'],
  [/faucet\.circle\.com/i, 'testnet faucet link'],
  [/PRIVATE_KEY|ETH_KEYSTORE_ACCOUNT|ARC_MAINNET_RPC_URL|CIRCLE_API_KEY|ENTITY_SECRET/, 'deployment secret variable name'],
]

const REQUIRED: Array<[string, string]> = [
  ['https://rpc.mainnet.arc.io', 'Arc Mainnet RPC'],
  ['https://explorer.arc.io', 'Arc Mainnet explorer'],
  ['0x3600000000000000000000000000000000000000', 'official Arc USDC address'],
  ['0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE', 'native USDC system emitter'],
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const problems: string[] = []
if (!existsSync(DIST)) {
  console.error('dist/ not found. Run `bun run build` first.')
  process.exit(1)
}

const files = walk(DIST)
const text = files.filter((f) => /\.(js|css|html|json|txt|map)$/.test(f))
const bundle = text.map((f) => readFileSync(f, 'utf8')).join('\n')

for (const [pattern, label] of FORBIDDEN) {
  const match = pattern.exec(bundle)
  if (match) problems.push(`Forbidden: ${label} (found "${match[0]}")`)
}
for (const [needle, label] of REQUIRED) {
  if (!bundle.includes(needle)) problems.push(`Missing: ${label} (${needle})`)
}
if (!/\b5042\b/.test(bundle)) problems.push('Missing: Arc Mainnet chain id 5042')
if (!existsSync(join(DIST, 'index.html'))) problems.push('Missing: dist/index.html')
if (!existsSync(join(DIST, '_redirects'))) problems.push('Missing: dist/_redirects (SPA routing on Netlify)')
if (!existsSync(join(DIST, '_headers'))) problems.push('Missing: dist/_headers')

if (problems.length > 0) {
  console.error('Build verification FAILED:')
  for (const p of problems) console.error(` - ${p}`)
  process.exit(1)
}
console.log(`Build verification passed: ${text.length} text files scanned, Arc Mainnet only, no testnet or secret strings.`)
