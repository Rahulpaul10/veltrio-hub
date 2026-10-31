import { unregisterDom } from './harness/dom'
import { cleanup, fireEvent, render, screen, waitFor, within } from './harness/rtl'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createPublicClient, getAddress, type Hex } from 'viem'
import { WagmiProvider, createConfig, injected } from 'wagmi'
import App from '@/App'
import { arcMainnet } from '@/config/network'
import { setPublicClientForTests } from '@/lib/rpc'
import { PREPARE } from '@/lib/prepare'
import { shouldCheckReceipt } from '@/lib/receipt'
import { localTxStore } from '@/lib/txStore'
import { formatAddress } from '@/lib/format'
import { FakeArc } from './harness/fakeArc'
import { MockWallet } from './harness/mockWallet'

/**
 * Whole-app tests: the real React app, real wagmi and viem, a mock browser wallet and an
 * in-memory Arc RPC. No network access and no funds are involved.
 */

const USDC = '0x3600000000000000000000000000000000000000'
const OTHER = getAddress('0x00000000000000000000000000000000000000b2')
const LONG = { timeout: 8000 }

let counter = 0xa000
const freshAccount = () => getAddress(`0x${(++counter).toString(16).padStart(40, '0')}`)

let arc: FakeArc
let wallet: MockWallet
let me: string
let qc: QueryClient

function mount(path = '/') {
  window.history.replaceState({}, '', path)
  ;(window as unknown as { ethereum: unknown }).ethereum = wallet
  setPublicClientForTests(createPublicClient({ chain: arcMainnet, transport: arc.transport }))
  const config = createConfig({ chains: [arcMainnet], connectors: [injected()], transports: { 5042: arc.transport }, storage: null })
  const client = (qc = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: 'always' }, mutations: { retry: false, networkMode: 'always' } } }))
  return render(
    <WagmiProvider config={config}>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>,
  )
}

async function connect() {
  fireEvent.click((await screen.findAllByRole('button', { name: /connect/i }, LONG))[0] as HTMLElement)
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: /injected/i }))
}

async function connectOk() {
  await connect()
  await screen.findByText(formatAddress(me), undefined, LONG)
}

const goto = (label: string) => {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByText(label))
}

async function fillSend(to: string, amount: string) {
  fireEvent.change(await screen.findByLabelText('Recipient address'), { target: { value: to } })
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: amount } })
}

beforeEach(() => {
  arc = new FakeArc()
  me = freshAccount()
  wallet = new MockWallet(me)
})
afterEach(() => {
  cleanup()
})
afterAll(async () => {
  await unregisterDom()
})

describe('wallet connection', () => {
  test('disconnected visitors see a connect prompt and no balance or history', async () => {
    mount()
    expect(await screen.findByText('Your USDC on Arc Mainnet')).toBeDefined()
    expect(screen.queryByLabelText('USDC balance')).toBeNull()
    goto('Send')
    expect(await screen.findByText('Connect to send')).toBeDefined()
    goto('Activity')
    expect(await screen.findByText('Connect to see activity')).toBeDefined()
  })

  test('connects, shows the address, the real USDC balance and live network status', async () => {
    arc.usdc = 1_234_560_000n // 1,234.56 USDC
    mount()
    await connectOk()
    expect(await screen.findByText('1,234.56', { exact: false }, LONG)).toBeDefined()
    expect(screen.getByText(/Live · block 5,000,000/)).toBeDefined()
    expect(screen.getAllByText(/Arc Mainnet/).length).toBeGreaterThan(0)
  }, 20000)

  test('a declined connection request shows a clear message and stays disconnected', async () => {
    wallet.rejectConnect = true
    mount()
    await connect()
    expect(await screen.findByText('You declined the connection request in your wallet.', undefined, LONG)).toBeDefined()
    expect(screen.queryByText(formatAddress(me))).toBeNull()
  })

  test('disconnect returns to the connect prompt', async () => {
    mount()
    await connectOk()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect wallet' }))
    expect(await screen.findByText('Your USDC on Arc Mainnet', undefined, LONG)).toBeDefined()
  })

  test('an account change in the wallet updates the app', async () => {
    mount()
    await connectOk()
    const second = freshAccount()
    wallet.setAccounts([second])
    expect(await screen.findByText(formatAddress(second), undefined, LONG)).toBeDefined()
    expect(screen.queryByText(formatAddress(me))).toBeNull()
  })
})

describe('network handling', () => {
  test('wrong wallet network: guided to Arc Mainnet, sending blocked, switch works', async () => {
    wallet.chainId = 1
    mount()
    await connectOk()
    expect(await screen.findByText('Your wallet is on a different network')).toBeDefined()
    goto('Send')
    expect((await screen.findAllByRole('button', { name: 'Switch to Arc Mainnet' })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Review transfer' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Switch to Arc Mainnet' })[0] as HTMLElement)
    await waitFor(() => expect(screen.queryByText('Your wallet is on a different network')).toBeNull(), LONG)
    expect(wallet.chainId).toBe(5042)
  }, 20000)

  test('declining the network switch is explained and nothing changes', async () => {
    wallet.chainId = 10
    wallet.rejectSwitch = true
    mount()
    await connectOk()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Switch to Arc Mainnet' }))[0] as HTMLElement)
    expect(await screen.findByText(/You declined the network switch/, undefined, LONG)).toBeDefined()
    expect(wallet.chainId).toBe(10)
  })

  test('a live chain change in the wallet shows and clears the warning', async () => {
    mount()
    await connectOk()
    expect(screen.queryByText('Your wallet is on a different network')).toBeNull()
    wallet.setChain(8453)
    expect(await screen.findByText('Your wallet is on a different network', undefined, LONG)).toBeDefined()
    wallet.setChain(5042)
    await waitFor(() => expect(screen.queryByText('Your wallet is on a different network')).toBeNull(), LONG)
  })

  test('an RPC that is on another network disables sending and says so', async () => {
    arc.chainId = 5042002
    mount()
    await connectOk()
    expect(await screen.findByText('RPC is on the wrong network', undefined, LONG)).toBeDefined()
  })
})

describe('receive', () => {
  test('shows the full connected address and copies it', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t: string) => Promise.resolve(void written.push(t)) }, configurable: true })
    mount()
    await connectOk()
    goto('Receive')
    expect((await screen.findByTestId('receive-address')).textContent).toBe(me)
    fireEvent.click(screen.getByRole('button', { name: /Copy address/ }))
    expect(await screen.findByText('Copied')).toBeDefined()
    expect(written).toEqual([me])
  })
})

describe('RPC failures', () => {
  test('balance and history errors are explained, retryable, and recover', async () => {
    arc.down = true
    mount()
    await connectOk()
    expect(await screen.findByText("Can't reach Arc Mainnet", undefined, LONG)).toBeDefined()
    expect(await screen.findByText('Unavailable', undefined, LONG)).toBeDefined()
    expect(await screen.findByText('Transaction history is unavailable', undefined, LONG)).toBeDefined()
    expect(screen.queryByText('No transactions found')).toBeNull()

    arc.down = false
    fireEvent.click(within(screen.getByLabelText('USDC balance')).getByRole('button', { name: /Retry/ }))
    expect(await screen.findByText('25.00', { exact: false }, LONG)).toBeDefined()
    fireEvent.click(within(screen.getByLabelText('Recent activity')).getByRole('button', { name: /Retry/ }))
    expect(await screen.findByText('No transactions found', undefined, LONG)).toBeDefined()
  }, 25000)

  test('history unavailable while balances work is shown as unavailable, not empty', async () => {
    arc.logsDown = true
    mount('/activity')
    await connectOk()
    expect(await screen.findByText('Transaction history is unavailable', undefined, LONG)).toBeDefined()
    expect(screen.queryByText('No transactions found')).toBeNull()
    arc.logsDown = false
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(await screen.findByText('No transactions found', undefined, LONG)).toBeDefined()
  }, 20000)
})

describe('transaction history', () => {
  test('lists real on-chain transfers with type, amount, status and explorer link', async () => {
    const hash = `0x${'11'.repeat(32)}` as Hex
    const hash2 = `0x${'22'.repeat(32)}` as Hex
    arc.addTransferLog({ block: 4_999_990n, hash, from: OTHER, to: me, valueNative: 3_000_000n * 10n ** 12n })
    arc.addTransferLog({ block: 4_999_995n, hash: hash2, from: me, to: OTHER, valueNative: 1_250_000n * 10n ** 12n })
    mount('/activity')
    await connectOk()
    expect(await screen.findByText('Received', undefined, LONG)).toBeDefined()
    expect(screen.getByText('Sent')).toBeDefined()
    expect(screen.getByText(/\+3\.00/)).toBeDefined()
    expect(screen.getByText(/−1\.25/)).toBeDefined()
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(links).toContain(`https://explorer.arc.io/tx/${hash}`)
    expect(links).toContain(`https://explorer.arc.io/tx/${hash2}`)
  }, 20000)
})

describe('sending USDC', () => {
  test('validates recipient, amount, balance and fee before allowing review', async () => {
    arc.usdc = 5_000_000n
    mount('/send')
    await connectOk()
    await fillSend('0x123', '1')
    expect(await screen.findByText(/full wallet address/)).toBeDefined()
    expect((screen.getByRole('button', { name: 'Fix the details above' }) as HTMLButtonElement).disabled).toBe(true)

    await fillSend(me, '1')
    expect(await screen.findByText(/your own address/)).toBeDefined()

    await fillSend(OTHER, '1.1234567')
    expect(await screen.findByText(/up to 6 decimal places/)).toBeDefined()

    await fillSend(OTHER, '5.01')
    expect(await screen.findByText(/more than your balance/, undefined, LONG)).toBeDefined()

    // The whole balance cannot be sent because USDC is also the gas token.
    await fillSend(OTHER, '5')
    expect(await screen.findByText(/Not enough USDC to cover the network fee/, undefined, LONG)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Review transfer' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Fix the details above' }) as HTMLButtonElement).disabled).toBe(true)
  }, 25000)

  test('happy path: estimate, review, wallet prompt, pending, then confirmed only after the receipt', async () => {
    mount('/send')
    await connectOk()
    await fillSend(OTHER, '1.5')
    expect(await screen.findByText(/~0\.001625 USDC/, undefined, LONG)).toBeDefined()
    fireEvent.click(await screen.findByRole('button', { name: 'Review transfer' }))
    expect(await screen.findByText(/Check every detail/)).toBeDefined()
    expect(screen.getByTestId('review-recipient').textContent).toBe(OTHER)
    expect(wallet.sent).toHaveLength(0) // nothing is sent before the user confirms

    fireEvent.click(screen.getByRole('button', { name: 'Confirm in wallet' }))
    expect(await screen.findByText('Submitted, waiting for confirmation', undefined, LONG)).toBeDefined()
    expect(screen.queryByText('Transfer confirmed')).toBeNull()

    expect(wallet.sent).toHaveLength(1)
    const tx = wallet.sent[0]
    expect(tx?.to.toLowerCase()).toBe(USDC)
    expect(tx?.from.toLowerCase()).toBe(me.toLowerCase())
    expect(tx?.data.startsWith('0xa9059cbb')).toBe(true) // transfer(address,uint256)
    expect(tx?.data.toLowerCase()).toContain(OTHER.toLowerCase().slice(2))
    expect(BigInt(`0x${tx?.data.slice(-64)}`)).toBe(1_500_000n)
    expect(BigInt(tx?.maxFeePerGas ?? '0x0')).toBeGreaterThanOrEqual(20n * 10n ** 9n)
    expect(tx?.value === undefined || BigInt(tx.value) === 0n).toBe(true)

    // Pending shows up in the store immediately.
    const hash = wallet.hashes[0] as Hex
    expect(localTxStore.get(me as `0x${string}`)[0]).toMatchObject({ hash, status: 'pending', amountRaw: '1500000' })

    arc.receipts.set(hash, { status: 'success', block: 5_000_001n, transfer: { from: me, to: OTHER, value: 1_500_000n } })
    expect(await screen.findByText('Transfer confirmed', undefined, { timeout: 10000 })).toBeDefined()
    expect(localTxStore.get(me as `0x${string}`)[0]?.status).toBe('confirmed')
  }, 30000)

  test('a reverted transaction is shown as failed, never as success', async () => {
    mount('/send')
    await connectOk()
    await fillSend(OTHER, '2')
    fireEvent.click(await screen.findByRole('button', { name: 'Review transfer' }, LONG))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm in wallet' }))
    await screen.findByText('Submitted, waiting for confirmation', undefined, LONG)
    arc.receipts.set(wallet.hashes[0] as Hex, { status: 'reverted', block: 5_000_002n })
    expect(await screen.findByText('Transfer failed', undefined, { timeout: 10000 })).toBeDefined()
    expect(screen.queryByText('Transfer confirmed')).toBeNull()
  }, 30000)

  test('a successful receipt WITHOUT the expected USDC transfer is never shown as success', async () => {
    mount('/send')
    await connectOk()
    await fillSend(OTHER, '2')
    fireEvent.click(await screen.findByRole('button', { name: 'Review transfer' }, LONG))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm in wallet' }))
    await screen.findByText('Submitted, waiting for confirmation', undefined, LONG)
    // Included successfully, but the logged transfer has a different amount than the one requested.
    arc.receipts.set(wallet.hashes[0] as Hex, { status: 'success', block: 5_000_003n, transfer: { from: me, to: OTHER, value: 999n } })
    expect(await screen.findByText('Included, but not verified', undefined, { timeout: 10000 })).toBeDefined()
    expect(screen.queryByText('Transfer confirmed')).toBeNull()
    goto('Activity')
    expect(await screen.findByText('Check explorer', undefined, LONG)).toBeDefined()
    expect(localTxStore.get(me as `0x${string}`)[0]?.status).toBe('unverified')
  }, 30000)

  test('rejecting in the wallet sends nothing and records nothing', async () => {
    wallet.mode = 'reject'
    mount('/send')
    await connectOk()
    await fillSend(OTHER, '1')
    fireEvent.click(await screen.findByRole('button', { name: 'Review transfer' }, LONG))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm in wallet' }))
    expect(await screen.findByText('You declined the request', undefined, LONG)).toBeDefined()
    expect(screen.getByText('Nothing was sent and no fee was charged.')).toBeDefined()
    expect(localTxStore.get(me as `0x${string}`)).toHaveLength(0)
    // The user can go straight back to review.
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer again' }))
    expect(await screen.findByRole('button', { name: 'Confirm in wallet' })).toBeDefined()
  }, 30000)

  test('double clicking confirm opens only one wallet prompt', async () => {
    wallet.mode = 'hang'
    mount('/send')
    await connectOk()
    await fillSend(OTHER, '1')
    fireEvent.click(await screen.findByRole('button', { name: 'Review transfer' }, LONG))
    const confirm = await screen.findByRole('button', { name: 'Confirm in wallet' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(await screen.findByText('Approve in your wallet')).toBeDefined()
    await waitFor(() => expect(wallet.sent).toHaveLength(1))
    expect(screen.queryByRole('button', { name: 'Confirm in wallet' })).toBeNull()
    wallet.approvePending()
    expect(await screen.findByText('Submitted, waiting for confirmation', undefined, LONG)).toBeDefined()
    expect(wallet.sent).toHaveLength(1)
  }, 30000)

  test('an ambiguous wallet failure never invites a blind retry', async () => {
    wallet.mode = 'fail'
    mount('/send')
    await connectOk()
    await fillSend(OTHER, '1')
    fireEvent.click(await screen.findByRole('button', { name: 'Review transfer' }, LONG))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm in wallet' }))
    expect(await screen.findByText('Check before you retry', undefined, LONG)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Review transfer again' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Check Activity' })).toBeDefined()
  }, 30000)

  test('a pending transfer appears in Activity immediately', async () => {
    mount('/send')
    await connectOk()
    await fillSend(OTHER, '0.75')
    fireEvent.click(await screen.findByRole('button', { name: 'Review transfer' }, LONG))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm in wallet' }))
    await screen.findByText('Submitted, waiting for confirmation', undefined, LONG)
    goto('Activity')
    expect(await screen.findByText('Pending', undefined, LONG)).toBeDefined()
    expect(screen.getByText(/−0\.75/)).toBeDefined()
  }, 30000)
})

/** Time (ms) helpers for the Confirm -> wallet path. */
async function reachReview(amount = '1') {
  mount('/send')
  await connectOk()
  await fillSend(OTHER, amount)
  fireEvent.click(await screen.findByRole('button', { name: 'Review transfer' }, LONG))
  return screen.findByRole('button', { name: 'Confirm in wallet' })
}

const sendRequests = () => wallet.timeline.filter((e) => e.method === 'eth_sendTransaction')

describe('Confirm to wallet latency', () => {
  const realNow = Date.now
  afterEach(() => {
    Date.now = realNow
    PREPARE.refreshTimeoutMs = 10_000
  })

  test('fresh data: a slow RPC never delays the wallet request, and no RPC call sits between click and wallet', async () => {
    const confirm = await reachReview()
    arc.latencyMs = 3000 // every RPC answer now takes 3s
    const rpcBefore = arc.timeline.length
    const t0 = performance.now()
    fireEvent.click(confirm)
    await waitFor(() => expect(sendRequests()).toHaveLength(1), { timeout: 2000 })
    const toWallet = (sendRequests()[0]?.at ?? 0) - t0
    expect(toWallet).toBeLessThan(500)
    // Nothing was requested from the RPC before the wallet request went out.
    const rpcBetween = arc.timeline.slice(rpcBefore).filter((e) => e.at <= (sendRequests()[0]?.at ?? 0))
    expect(rpcBetween.map((e) => e.method)).toEqual([])
    expect(await screen.findByText('Submitted, waiting for confirmation', undefined, LONG)).toBeDefined()
  }, 30000)

  test('a slow wallet provider is not app-side delay: the first wallet request leaves immediately', async () => {
    const confirm = await reachReview()
    wallet.latencyMs = 400
    const w0 = wallet.timeline.length
    const t0 = performance.now()
    fireEvent.click(confirm)
    expect(await screen.findByText('Approve in your wallet')).toBeDefined() // the UI answers at once
    await waitFor(() => expect(wallet.timeline.length).toBeGreaterThan(w0))
    expect((wallet.timeline[w0]?.at ?? 0) - t0).toBeLessThan(100) // app -> provider
    await waitFor(() => expect(sendRequests()).toHaveLength(1), { timeout: 3000 })
    expect(wallet.timeline.slice(w0).map((e) => e.method)).toEqual(['eth_chainId', 'eth_sendTransaction'])
  }, 30000)

  test('stale data: fee and balances are re-read in parallel, with visible feedback, then one wallet request', async () => {
    const confirm = await reachReview()
    arc.latencyMs = 1200
    Date.now = () => realNow() + 120_000 // the shown quote and balances are now older than the freshness limit
    const rpcBefore = arc.timeline.length
    const t0 = performance.now()
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(await screen.findByText('Checking your latest fee and balance')).toBeDefined()
    expect(sendRequests()).toHaveLength(0) // wallet is not opened on stale data
    await waitFor(() => expect(sendRequests()).toHaveLength(1), { timeout: 6000 })
    const refreshCalls = arc.timeline.slice(rpcBefore).filter((e) => e.at <= (sendRequests()[0]?.at ?? 0))
    const methods = refreshCalls.map((e) => e.method)
    expect(methods).toContain('eth_estimateGas')
    expect(methods).toContain('eth_getBalance')
    expect(methods).toContain('eth_call')
    // Parallel: all re-reads started together, so the total is about one RPC latency, not several.
    const starts = refreshCalls.map((e) => e.at)
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(300)
    expect((sendRequests()[0]?.at ?? 0) - t0).toBeLessThan(3500)
    expect(sendRequests()).toHaveLength(1)
  }, 30000)

  test('stale data and an unreachable RPC: nothing is sent, the user is told, and can retry', async () => {
    const confirm = await reachReview()
    arc.down = true
    Date.now = () => realNow() + 120_000
    fireEvent.click(confirm)
    expect(await screen.findByText('Transfer not sent', undefined, LONG)).toBeDefined()
    expect(screen.getByText(/Nothing was sent/)).toBeDefined()
    expect(sendRequests()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Review transfer again' })).toBeDefined()
  }, 30000)

  test('stale data and a very slow RPC: the refresh stops at its deadline instead of freezing', async () => {
    const confirm = await reachReview()
    PREPARE.refreshTimeoutMs = 400
    arc.latencyMs = 5000
    Date.now = () => realNow() + 120_000
    const t0 = performance.now()
    fireEvent.click(confirm)
    expect(await screen.findByText('Checking your latest fee and balance')).toBeDefined()
    expect(await screen.findByText(/too slow to confirm your latest fee and balance/, undefined, { timeout: 3000 })).toBeDefined()
    expect(performance.now() - t0).toBeLessThan(2500)
    expect(sendRequests()).toHaveLength(0)
  }, 30000)

  test('stale data and a balance that dropped: the wallet is never opened', async () => {
    const confirm = await reachReview('2')
    arc.usdc = 1_000_000n
    Date.now = () => realNow() + 120_000
    fireEvent.click(confirm)
    expect(await screen.findByText(/Your balance is now 1\.00 USDC/, undefined, LONG)).toBeDefined()
    expect(sendRequests()).toHaveLength(0)
  }, 30000)

  test('stale data and a fee that jumped: back to review with the new fee, wallet not opened', async () => {
    const confirm = await reachReview()
    arc.baseFeeGwei = 200n
    Date.now = () => realNow() + 120_000
    fireEvent.click(confirm)
    expect(await screen.findByText(/The network fee changed to up to/, undefined, LONG)).toBeDefined()
    expect(sendRequests()).toHaveLength(0)
  }, 30000)

  test('after a stale refresh, a wallet rejection and an ambiguous failure still behave safely', async () => {
    let confirm = await reachReview()
    wallet.mode = 'reject'
    Date.now = () => realNow() + 120_000
    fireEvent.click(confirm)
    expect(await screen.findByText('You declined the request', undefined, LONG)).toBeDefined()
    expect(sendRequests()).toHaveLength(1)
    expect(localTxStore.get(me as `0x${string}`)).toHaveLength(0)

    wallet.mode = 'fail'
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer again' }))
    confirm = await screen.findByRole('button', { name: 'Confirm in wallet' })
    Date.now = () => realNow() + 240_000
    fireEvent.click(confirm)
    expect(await screen.findByText('Check before you retry', undefined, LONG)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Review transfer again' })).toBeNull()
    expect(sendRequests()).toHaveLength(2) // one request per confirmation, never an automatic retry
  }, 40000)

  test('the wallet moving to another network during the refresh blocks the request', async () => {
    const confirm = await reachReview()
    arc.latencyMs = 600
    Date.now = () => realNow() + 120_000
    fireEvent.click(confirm)
    await screen.findByText('Checking your latest fee and balance')
    wallet.setChain(1)
    expect(await screen.findByText(/not on Arc Mainnet/, undefined, LONG)).toBeDefined()
    expect(sendRequests()).toHaveLength(0)
  }, 30000)
})

describe('request volume (rate-limit safety)', () => {
  const logCalls = () => arc.timeline.filter((e) => e.method === 'eth_getLogs').length

  test('moving between pages does not rescan the whole history again', async () => {
    mount('/')
    await connectOk()
    await screen.findByText('No transactions found', undefined, LONG)
    const afterFirst = logCalls()
    expect(afterFirst).toBeGreaterThan(20) // the first scan really searches many windows
    goto('Activity')
    await screen.findByText('No transactions found', undefined, LONG)
    goto('Home')
    await screen.findByText('No transactions found', undefined, LONG)
    // Two more page visits cost at most a small forward scan each, not another full scan.
    expect(logCalls() - afterFirst).toBeLessThanOrEqual(8)
  }, 30000)

  test('cached history still picks up a transfer that arrived in between', async () => {
    mount('/activity')
    await connectOk()
    await screen.findByText('No transactions found', undefined, LONG)
    arc.head += 5n
    arc.addTransferLog({ block: arc.head, hash: `0x${'55'.repeat(32)}` as Hex, from: OTHER, to: me, valueNative: 4_000_000n * 10n ** 12n })
    goto('Home')
    expect(await screen.findByText('Received', undefined, LONG)).toBeDefined()
    expect(screen.getByText(/\+4\.00/)).toBeDefined()
  }, 30000)

  test('an old pending transaction is polled slowly, not every 2.5 seconds forever', async () => {
    const hash = `0x${'77'.repeat(32)}` as Hex
    localTxStore.add({ hash, from: me as `0x${string}`, to: OTHER, amountRaw: '1000000', createdAt: Date.now() - 15 * 60 * 1000, status: 'pending' })
    mount('/activity')
    await connectOk()
    await screen.findByText('Not confirmed', undefined, LONG)
    await new Promise((r) => setTimeout(r, 6000)) // spans two watcher ticks
    expect(arc.timeline.filter((e) => e.method === 'eth_getTransactionReceipt').length).toBe(1)
    expect(shouldCheckReceipt(Date.now() - 15 * 60 * 1000, Date.now(), Date.now())).toBe(false)
  }, 30000)
})

describe('review screen stays consistent with live balances and fees', () => {
  test('if the fee rises so the balance no longer covers amount + fee, Confirm is disabled and the wallet is never opened', async () => {
    const confirm = await reachReview('24.99') // leaves 0.01 USDC for the fee
    arc.baseFeeGwei = 5000n // worst-case fee is now far above 0.01 USDC
    await qc.invalidateQueries({ queryKey: ['fee'] })
    expect(await screen.findByText('This transfer can no longer be sent', undefined, LONG)).toBeDefined()
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirm)
    await new Promise((r) => setTimeout(r, 300))
    expect(wallet.sent).toHaveLength(0)
  }, 30000)

  test('if the balance drops below the amount while reviewing, the wallet cannot be reached either', async () => {
    await reachReview('1.5')
    arc.usdc = 500_000n
    await qc.invalidateQueries({ queryKey: ['balances'] })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm in wallet' })).toBeNull(), { timeout: 8000 })
    expect(wallet.sent).toHaveLength(0)
  }, 30000)
})
