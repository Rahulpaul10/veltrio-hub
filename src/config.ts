/**
 * wagmi configuration: Arc Mainnet only, injected wallets only.
 * No testnet and no second chain is configured, so the app cannot silently
 * read from or write to another network.
 * Built with Arc Studio — https://studio.arc.io
 */

import { createConfig, injected } from 'wagmi'
import { NETWORK, arcMainnet } from '@/config/network'
import { createArcTransport } from '@/lib/rpc'
import { registerChain } from './tracing'

// Pre-register chain RPC URL so trace events show the right chain name immediately
registerChain(NETWORK.chainId, NETWORK.rpcUrls[0] ?? '')

export const config = createConfig({
  chains: [arcMainnet],
  connectors: [injected()],
  transports: {
    [NETWORK.chainId]: createArcTransport(),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
