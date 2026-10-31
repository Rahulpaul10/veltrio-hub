import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { NETWORK } from '@/config/network'
import { usdcAbi } from '@/abi/usdc'
import { getPublicClient } from '@/lib/rpc'
import { describeReadError } from '@/lib/errors'
import { fetchTransferFeeQuote } from '@/lib/fees'

export const STALE_BLOCK_SECONDS = 120

export type ChainHealth =
  | { status: 'checking' }
  | { status: 'ok'; block: bigint; ageSeconds: number }
  | { status: 'stale'; block: bigint; ageSeconds: number }
  | { status: 'chain-mismatch'; rpcChainId: number }
  | { status: 'error'; message: string }

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

/** Checks the RPC is really Arc Mainnet, is producing blocks, and that the configured USDC is the real 6-decimal USDC. */
export function useChainHealth() {
  const chain = useQuery({
    queryKey: ['health', 'chain'],
    queryFn: async () => {
      const rpcChainId = await getPublicClient().getChainId()
      if (rpcChainId !== NETWORK.chainId) return { mismatch: true as const, rpcChainId }
      const block = await getPublicClient().getBlock()
      return {
        mismatch: false as const,
        block: block.number,
        ageSeconds: Math.max(0, Math.floor(Date.now() / 1000 - Number(block.timestamp))),
      }
    },
    refetchInterval: 15_000,
  })

  const token = useQuery({
    queryKey: ['health', 'usdc', NETWORK.usdc.address],
    queryFn: async () => {
      const [decimals, symbol] = await Promise.all([
        getPublicClient().readContract({ address: NETWORK.usdc.address, abi: usdcAbi, functionName: 'decimals' }),
        getPublicClient().readContract({ address: NETWORK.usdc.address, abi: usdcAbi, functionName: 'symbol' }),
      ])
      return decimals === NETWORK.usdc.decimals && symbol === NETWORK.usdc.symbol
    },
    staleTime: Infinity,
  })

  let health: ChainHealth = { status: 'checking' }
  if (chain.data?.mismatch) {
    health = { status: 'chain-mismatch', rpcChainId: chain.data.rpcChainId }
  } else if (chain.data) {
    const { block, ageSeconds } = chain.data
    health = ageSeconds > STALE_BLOCK_SECONDS ? { status: 'stale', block, ageSeconds } : { status: 'ok', block, ageSeconds }
  }
  if (chain.isError) {
    health = { status: 'error', message: describeReadError(chain.error) }
  }

  return {
    health,
    /** true = verified, false = the configured address is not 6-decimal USDC, undefined = not checked yet. */
    tokenVerified: token.isError ? undefined : token.data,
    refetch: () => {
      void chain.refetch()
      if (token.isError) void token.refetch()
    },
    isFetching: chain.isFetching,
  }
}

export function useBalances(address: Address | undefined) {
  return useQuery({
    queryKey: ['balances', address],
    enabled: Boolean(address),
    queryFn: async () => {
      if (!address) throw new Error('No address')
      const [usdc, native] = await Promise.all([
        getPublicClient().readContract({ address: NETWORK.usdc.address, abi: usdcAbi, functionName: 'balanceOf', args: [address] }),
        getPublicClient().getBalance({ address }),
      ])
      return { usdc, native }
    },
    refetchInterval: 15_000,
  })
}

export function useFeeQuote(params: { account?: Address; to?: Address; amountRaw?: bigint }) {
  const { account, to, amountRaw } = params
  const enabled = Boolean(account && to && amountRaw !== undefined && amountRaw > 0n)
  return useQuery({
    queryKey: ['fee', account, to, amountRaw?.toString()],
    enabled,
    queryFn: () => {
      if (!account || !to || amountRaw === undefined) throw new Error('Missing transfer details')
      return fetchTransferFeeQuote(getPublicClient(), { account, to, amountRaw })
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  })
}

export function useRefreshAll() {
  const client = useQueryClient()
  return () => client.invalidateQueries()
}
