import { afterEach, describe, expect, test } from 'bun:test'
import { createArcPublicClient } from '@/lib/rpc'

type Handler = (call: number, body: { id: number; method: string }) => Response | Promise<Response>

const servers: Array<{ stop: (force?: boolean) => void }> = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

function rpcServer(handler: Handler) {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string }
      calls++
      return handler(calls, body)
    },
  })
  servers.push(server)
  return { url: `http://localhost:${server.port}`, calls: () => calls }
}

const ok = (id: number, result: unknown) => Response.json({ jsonrpc: '2.0', id, result })
const fast = { retryDelay: 5, timeout: 400 }

describe('read-only RPC reliability', () => {
  test('retries a temporary failure (503) and then succeeds', async () => {
    const s = rpcServer((n, body) => (n < 3 ? new Response('busy', { status: 503 }) : ok(body.id, '0x13b2')))
    const client = createArcPublicClient([s.url], fast)
    expect(await client.getChainId()).toBe(5042)
    expect(s.calls()).toBe(3)
  })

  test('retries a rate limit (429) with backoff', async () => {
    const s = rpcServer((n, body) => (n === 1 ? new Response('slow down', { status: 429 }) : ok(body.id, '0x10')))
    const client = createArcPublicClient([s.url], fast)
    expect(await client.getBlockNumber()).toBe(16n)
    expect(s.calls()).toBe(2)
  })

  test('retries the "block not imported yet" error (-32014) seen on load-balanced backends', async () => {
    const s = rpcServer((n, body) =>
      n === 1 ? Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32014, message: 'block not found' } }) : ok(body.id, '0x2'),
    )
    const client = createArcPublicClient([s.url], fast)
    expect(await client.getBlockNumber()).toBe(2n)
    expect(s.calls()).toBe(2)
  })

  test('gives up after a limited number of retries instead of looping forever', async () => {
    const s = rpcServer(() => new Response('down', { status: 503 }))
    const client = createArcPublicClient([s.url], { ...fast, retryCount: 2 })
    await expect(client.getBlockNumber()).rejects.toThrow()
    expect(s.calls()).toBe(3) // first attempt + 2 retries
  })

  test('times out a hung endpoint', async () => {
    const s = rpcServer(async (_n, body) => {
      await Bun.sleep(1_000)
      return ok(body.id, '0x1')
    })
    const client = createArcPublicClient([s.url], { retryDelay: 5, timeout: 100, retryCount: 1 })
    const started = Date.now()
    await expect(client.getBlockNumber()).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(900)
  })

  test('falls back to the next endpoint when the first is down', async () => {
    const dead = rpcServer(() => new Response('down', { status: 500 }))
    const live = rpcServer((_n, body) => ok(body.id, '0x5'))
    const client = createArcPublicClient([dead.url, live.url], fast)
    expect(await client.getBlockNumber()).toBe(5n)
    expect(live.calls()).toBe(1)
  })

  test('does not retry a deterministic execution error', async () => {
    const s = rpcServer((_n, body) => Response.json({ jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted' } }))
    const client = createArcPublicClient([s.url], fast)
    await expect(client.getBlockNumber()).rejects.toThrow()
    expect(s.calls()).toBe(1)
  })

  test('the client itself has no way to send a transaction by itself (wallet-only submission)', () => {
    const client = createArcPublicClient(['http://localhost:1'], fast) as unknown as Record<string, unknown>
    expect(client.sendTransaction).toBeUndefined()
    expect(client.writeContract).toBeUndefined()
  })
})
