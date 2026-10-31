import { useAccount, useDisconnect, useSwitchChain } from 'wagmi'
import { NETWORK } from '@/config/network'
import { isUserRejection } from '@/lib/errors'

export type WalletStatus = 'disconnected' | 'connecting' | 'wrong-chain' | 'ready'

/** Wallet connection and network state. `chainId` is the wallet's real chain, not the app default. */
export function useWallet() {
  const { address, status, chainId, connector } = useAccount()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: switching, error: switchError, reset: resetSwitch } = useSwitchChain()

  let walletStatus: WalletStatus
  if (status === 'connecting' || status === 'reconnecting') walletStatus = 'connecting'
  else if (status !== 'connected' || !address) walletStatus = 'disconnected'
  else if (chainId !== NETWORK.chainId) walletStatus = 'wrong-chain'
  else walletStatus = 'ready'

  return {
    status: walletStatus,
    address: walletStatus === 'ready' || walletStatus === 'wrong-chain' ? address : undefined,
    chainId,
    walletName: connector?.name,
    disconnect: () => disconnect(),
    switching,
    switchToArc: () => {
      resetSwitch()
      switchChain({ chainId: NETWORK.chainId })
    },
    switchMessage: switchError
      ? isUserRejection(switchError)
        ? 'You declined the network switch. Your wallet is still on another network.'
        : 'Your wallet could not switch networks. Add Arc Mainnet manually (chain ID 5042) and try again.'
      : undefined,
  }
}
