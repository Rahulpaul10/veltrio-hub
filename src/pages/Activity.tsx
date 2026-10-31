import { useWallet } from '@/hooks/useWallet'
import { ConnectPrompt } from '@/components/ConnectPrompt'
import { HistoryPanel } from '@/components/HistoryPanel'
import { PageTitle } from '@/components/ui'

export function Activity() {
  const wallet = useWallet()
  return (
    <>
      <PageTitle title="Activity" subtitle="USDC sent and received by your wallet on Arc Mainnet." />
      {wallet.address ? (
        <section className="card p-5">
          <HistoryPanel address={wallet.address} />
        </section>
      ) : (
        <ConnectPrompt title="Connect to see activity" body="Your transaction history is read from Arc Mainnet for the wallet you connect." />
      )}
    </>
  )
}
