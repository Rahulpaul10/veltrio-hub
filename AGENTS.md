# Veltrio

> Built with Arc Studio - money-powered apps in minutes

Project memory for future agents and humans.

## What this app does

Veltrio is a simple USDC wallet dashboard for **Arc Mainnet only**. Four screens: Dashboard (balance, network status, Send/Receive shortcuts, recent activity), Send, Receive, Activity. Do not add features beyond these without being asked.

## Network (do not change silently)

- Arc Mainnet, chain ID **5042** (`0x13B2`), RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`
- USDC (ERC-20 view, 6 decimals): `0x3600000000000000000000000000000000000000`. Verified on-chain (`decimals()` = 6, `symbol()` = USDC) and against Arc's contract-address docs. The same funds are the 18-decimal native gas token. Show one USDC balance, never add the two views.
- No testnet anywhere in app code. `src/__tests__/network.test.ts` fails if a testnet id/URL appears, and `bun run verify:build` fails if the bundle contains one. `vite.config.ts` reduces the generated `src/onchain-facts.ts` to Arc Mainnet at build time (the build fails if it cannot).
- No custom contract is deployed. `contracts/deployments/arc-mainnet.json` is intentionally empty. Never invent an address.

## Tech stack

React 18, Vite, TypeScript, Tailwind. wagmi v2 + viem (injected wallets only, own connect picker; ConnectKit is not used). Tests: Bun (`bun test`), happy-dom and Testing Library for whole-app tests.

## Key files

- `src/config/network.ts` single place for domain, RPC, USDC and deployed contract addresses (reads `.env` `VITE_SITE_DOMAIN`, `VITE_RPC_URLS`, and `contracts/deployments/arc-mainnet.json`)
- `src/config.ts` wagmi config (Arc Mainnet only)
- `src/lib/rpc.ts` read-only RPC: timeout, endpoint fallback, 3 retries with exponential backoff, retry of Arc's `-32014`. `setPublicClientForTests` is the test seam.
- `src/lib/sendFlow.ts` transfer state machine; `src/hooks/useSendTransfer.ts` submission; `src/hooks/useLocalTxs.ts` receipt watcher
- `src/lib/history.ts` history from the native USDC system emitter (`0xffff…fffE`, EIP-7708, 18 decimals), scanned in 9,000-block windows (RPC limit is 10,000)
- `src/lib/txStore.ts` transfers submitted from this browser (localStorage), so pending/reverted ones show in Activity
- `contracts/` Solidity, `contracts/abi/`, `contracts/deployments/`; `docs/DEPLOYMENT.md`

## Commands

```bash
bun run dev            # dev server
bun run check          # oxlint (type-aware) + tsc for app and tests
bun test               # all tests (unit + whole-app integration)
bun run build          # production build to dist/
bun run verify:build   # fails on testnet strings, secret names, missing Arc Mainnet values or missing SPA files
```

## Test setup

- Unit tests: validation, fees, errors, state machine, store, history scan/merge, formatting, config.
- RPC tests: a local HTTP server simulates 503/429/-32014/timeouts/fallback/non-retryable errors.
- Integration (`src/__tests__/app.integration.test.tsx`): the real app in happy-dom with a **mock EIP-1193 wallet** (`harness/mockWallet.ts`) and an **in-memory Arc RPC** (`harness/fakeArc.ts`). Nothing touches the network or real funds. These are NOT proof of a real onchain transfer.
- No real browser or mobile-wallet tests exist (the sandbox cannot launch a browser). Verify manually.

## Security and transaction rules

- Never put private keys, seed phrases or API secrets in code or in a `VITE_` variable (bundled publicly). Deployment settings live in `.env` (gitignored). The repository intentionally contains no environment files or templates; optional variables are documented in README.md and docs/DEPLOYMENT.md.
- Transactions are signed and broadcast only by the user's wallet via a single `writeContract` call after a Review step. The RPC client has no send methods and read retries never apply to submissions.
- Never auto-resubmit. After an error that does not prove nothing was sent (network/unknown/internal wallet error), the UI blocks going back to review and tells the user to check Activity and their wallet. viem's mislabel of "Internal JSON-RPC error" as a revert is treated as ambiguous.
- "Confirmed" only when the receipt has status success AND the official USDC contract logged the exact transfer requested (sender, recipient, amount; `src/lib/receipt.ts`). A successful receipt without that log is "Included, but not verified" (never success); "Failed" only from a reverted receipt; no receipt = Pending (never failed). Pending older than 10 minutes is labeled "Not confirmed" (may be replaced or dropped).
- Confirm path (`src/hooks/useSendTransfer.ts`, `src/lib/prepare.ts`): with a fee quote and balances younger than 30 s the wallet request leaves with no network wait. Older data is re-read in parallel (10 s deadline), re-validated, and the wallet is only opened if it still passes; otherwise nothing is sent. Dev-only timing marks (`src/lib/sendTiming.ts`) log durations to the console, never addresses, amounts or hashes.
- Request volume: history keeps the last good scan per address in memory (page changes only scan new blocks); receipt polling slows to every 30 s for pending transfers older than 10 minutes; `getBlockNumber` for scans bypasses viem's 4 s cache.
- Amount field: `normalizeAmountInput` never guesses (ambiguous `1,000` is rejected, `1,000.50` becomes `1000.50`). Confirm is disabled whenever the live balance/fee no longer covers the transfer. Wallets are only asked to add the official RPC.
- Fees: `maxFeePerGas` is at least 20 gwei (Arc floor). Amount plus worst-case fee must fit in the balance because USDC is gas.
- Do not deploy to Netlify, connect a domain, deploy a contract or send real funds without the owner's explicit permission.

## Share links

- `src/lib/share.ts` ships `getShareBase`, `buildShareLink`, `installShareSync`; keep the `installShareSync()` call in `src/main.tsx`. Never put secrets in URL paths or queries.

## Deployment

Netlify config is in `netlify.toml`, `public/_redirects`, `public/_headers`. Steps for domain/DNS are in `docs/DEPLOYMENT.md`. Not deployed yet.

## Custom contract (source only)

- `contracts/Veltrio.sol` (solc 0.8.28, OpenZeppelin 5.6.1 Ownable2Step/Pausable/SafeERC20) is an Arc Mainnet-only (chain 5042) non-custodial payment-reference helper with a limited owner (`initialOwner` constructor argument; pause for at most 3 days with a 1-day cooldown, rescue stray balances, two-step ownership; cannot touch users' funds). It is NOT deployed, NOT independently audited and NOT connected to the app. Send still calls the official Arc USDC contract directly.
- `contracts/deployments/arc-mainnet.json` must stay empty until the owner deploys it themselves; never add placeholder addresses. The official USDC address lives only in `src/config/network.ts`.
- Checks: `bun run contracts:build`, `bun run contracts:test` (149 Foundry tests including invariants; the invariant run takes a few minutes). Remix steps: `contracts/README.md`.
- `public/vercel.json` is required for Vercel (rewrites for deep links and security headers; Vercel ignores `_redirects`/`_headers`). Keep it committed.
- Pause expiry emits no `Unpaused` event: read `paused()`. Pin OpenZeppelin 5.6.1 in Remix (flatten or versioned imports); see `contracts/README.md`.
