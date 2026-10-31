import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

/**
 * Veltrio is Arc Mainnet only. The generated `src/onchain-facts.ts` registry lists many
 * networks, including testnets. This plugin rewrites it at build time so the bundle only
 * ever contains Arc Mainnet (chain 5042) and mainnet protocol contracts. If the registry
 * format changes and the rewrite cannot be applied, the production build fails instead of
 * shipping testnet data.
 */
function arcMainnetOnlyFacts(): Plugin {
  let isBuild = false
  const START = 'const FACTS: OnchainFacts = '
  const END = ';\n\nexport const ONCHAIN_CHAINS'
  return {
    name: 'veltrio-arc-mainnet-only-facts',
    enforce: 'pre',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    transform(code, id) {
      if (!id.split('?')[0].endsWith('/src/onchain-facts.ts')) return null
      const start = code.indexOf(START)
      const end = code.indexOf(END)
      try {
        if (start === -1 || end === -1) throw new Error('registry layout changed')
        const facts = JSON.parse(code.slice(start + START.length, end)) as {
          chains: Array<{ chainId: number }>
          protocolContracts: Array<{ networkKind?: string }>
        }
        const chains = facts.chains.filter((c) => c.chainId === 5042)
        if (chains.length !== 1) throw new Error('Arc Mainnet (5042) missing from registry')
        const filtered = {
          chains,
          protocolContracts: facts.protocolContracts.filter((c) => c.networkKind === 'mainnet'),
        }
        return {
          code: code.slice(0, start + START.length) + JSON.stringify(filtered, null, 2) + code.slice(end),
          map: null,
        }
      } catch (error) {
        const message = `[veltrio] could not reduce onchain-facts to Arc Mainnet: ${(error as Error).message}`
        if (isBuild) throw new Error(message)
        console.warn(message)
        return null
      }
    },
  }
}

export default defineConfig({
  plugins: [arcMainnetOnlyFacts(), react(), nodePolyfills()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@tanstack/react-query',
      'wagmi',
      'viem',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
    chunkSizeWarningLimit: 900,
  },
  server: {
    allowedHosts: true,
    cors: true,
  },
  preview: {
    allowedHosts: true,
  },
})
