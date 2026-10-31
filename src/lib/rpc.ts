/**
 * RPC access for read-only requests: per-request timeout, endpoint fallback and a
 * small number of retries with exponential backoff (150ms-style doubling).
 *
 * Transactions are NOT sent through here. They are signed and broadcast by the
 * user's wallet, and nothing in this app retries a submission.
 */

import { createPublicClient, fallback, http, type PublicClient, type Transport } from 'viem'
import { NETWORK, arcMainnet } from '@/config/network'

export const RPC_TIMEOUT_MS = 10_000
export const RPC_RETRY_COUNT = 3
export const RPC_RETRY_DELAY_MS = 300

export interface TransportOptions {
  timeout?: number
  retryCount?: number
  retryDelay?: number
}

/** Arc's load-balanced RPC answers -32014 when a backend has not imported a block yet. Safe to retry. */
const BLOCK_NOT_IMPORTED = -32014

function hasRpcCode(error: unknown, code: number): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === code) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function retryBlockLag(inner: Transport, retryCount: number, retryDelay: number): Transport {
  return (params) => {
    const transport = inner(params)
    return {
      ...transport,
      request: (async (args: Parameters<typeof transport.request>[0]) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await transport.request(args)
          } catch (error) {
            if (attempt >= retryCount || !hasRpcCode(error, BLOCK_NOT_IMPORTED)) throw error
            await sleep(retryDelay * 2 ** attempt)
          }
        }
      }),
    }
  }
}

/**
 * One http transport per endpoint (no per-endpoint retry), wrapped by a fallback
 * that moves to the next endpoint and then retries the whole set with backoff:
 * delay = 2^attempt * retryDelay.
 */
export function createArcTransport(urls: readonly string[] = NETWORK.rpcUrls, options: TransportOptions = {}): Transport {
  const { timeout = RPC_TIMEOUT_MS, retryCount = RPC_RETRY_COUNT, retryDelay = RPC_RETRY_DELAY_MS } = options
  return retryBlockLag(
    fallback(
      urls.map((url) => http(url, { timeout, retryCount: 0 })),
      { retryCount, retryDelay, rank: false },
    ),
    retryCount,
    retryDelay,
  )
}

export function createArcPublicClient(urls?: readonly string[], options?: TransportOptions): PublicClient {
  return createPublicClient({ chain: arcMainnet, transport: createArcTransport(urls, options) })
}

let current: PublicClient = createArcPublicClient()

/** The app-wide read-only Arc Mainnet client. */
export function getPublicClient(): PublicClient {
  return current
}

/** Test seam: lets integration tests run the whole app against an in-memory chain. */
export function setPublicClientForTests(client: PublicClient): void {
  current = client
}
