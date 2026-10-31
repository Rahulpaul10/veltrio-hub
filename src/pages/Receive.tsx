import { NETWORK, explorerAddressUrl } from '@/config/network'
import { useWallet } from '@/hooks/useWallet'
import { ConnectPrompt } from '@/components/ConnectPrompt'
import { CopyButton, ExternalLink, Notice, PageTitle } from '@/components/ui'

export function Receive() {
  const wallet = useWallet()

  if (!wallet.address) {
    return (
      <>
        <PageTitle title="Receive" />
        <ConnectPrompt title="Connect to see your address" body="Your receiving address is the address of the wallet you connect." />
      </>
    )
  }

  return (
    <>
      <PageTitle title="Receive USDC" subtitle="Share this address to receive USDC on Arc Mainnet." />
      <section className="card p-5">
        <p className="label">Your address</p>
        <p className="mono mt-2 text-[15px] leading-relaxed break-all select-all" data-testid="receive-address">
          {wallet.address}
        </p>
        <div className="mt-4 grid gap-3">
          <CopyButton value={wallet.address} label="Copy address" className="btn-primary !bg-[var(--accent)] !text-white" />
          <ExternalLink href={explorerAddressUrl(wallet.address)} className="justify-center text-sm">
            View on Arc Explorer
          </ExternalLink>
        </div>
      </section>
      <Notice tone="warning" title="Arc Mainnet only">
        Only send USDC on Arc Mainnet (chain ID {NETWORK.chainId}) to this address. USDC sent on other networks such as Ethereum or Base will not arrive here.
      </Notice>
      {wallet.status === 'wrong-chain' && (
        <Notice tone="info">Your wallet is currently on another network. Receiving works regardless, but switch to Arc Mainnet to send.</Notice>
      )}
    </>
  )
}
