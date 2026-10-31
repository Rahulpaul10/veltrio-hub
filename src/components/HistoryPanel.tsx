import type { Address } from 'viem'
import { useBlockTimes, useHistory } from '@/hooks/useHistory'
import { HistoryView } from '@/components/TxList'

export function HistoryPanel({ address, limit }: { address: Address; limit?: number }) {
  const history = useHistory(address)
  const visible = limit ? history.items.slice(0, limit) : history.items
  const times = useBlockTimes(visible.flatMap((i) => (i.blockNumber !== undefined ? [i.blockNumber] : [])))

  return (
    <HistoryView
      status={history.status}
      items={history.items}
      times={times}
      error={history.error}
      refreshError={history.refreshError}
      loadingOlder={history.loadingOlder}
      refreshing={history.refreshing}
      reachedStart={history.reachedStart}
      scannedBlocks={history.scannedBlocks}
      limit={limit}
      onRetry={history.retry}
      onRefresh={history.refresh}
      onLoadOlder={history.loadOlder}
    />
  )
}
