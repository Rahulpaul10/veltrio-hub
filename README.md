# Veltrio

A simple USDC wallet dashboard for Arc Mainnet: see your balance, send and receive USDC, and follow every transfer from pending to confirmed.

Built with [Arc Studio](https://studio.arc.io)

## Features

- Connect a browser wallet and see your address, USDC balance and network status
- Send USDC with address and amount checks, a fee estimate and a confirmation in your own wallet
- Receive page with your address and a copy button
- Activity list with status and explorer links, including clear loading, empty, error and retry states
- A transfer is shown as confirmed only after Arc's receipt proves the exact USDC transfer you requested
- Arc Mainnet only (chain ID 5042). The app never switches you to another network

## Tech stack

React 18, TypeScript, Vite, Tailwind CSS, wagmi and viem (browser wallets). Tests run with Bun.

## Development

Prerequisites: [Bun](https://bun.sh) 1.3 or newer.

```bash
bun install
bun run dev        # local dev server
bun run check      # lint and type checks
bun test           # unit, RPC and whole-app tests (mock wallet, no real funds)
bun run build      # production build into dist/
bun run verify:build   # checks dist/ is Arc Mainnet only and has no secrets
bun run preview    # serve the production build locally
```

### Environment variables

Copy `.env.example` to `.env`. All are optional.

| Name | Purpose |
| --- | --- |
| `VITE_SITE_DOMAIN` | Your own domain, shown in the footer |
| `VITE_RPC_URLS` | Extra https Arc Mainnet RPC endpoints, tried before the default |
| `ARC_MAINNET_RPC_URL`, `ETH_KEYSTORE_ACCOUNT`, `ARC_EXPLORER_VERIFIER_URL` | Only for deploying your own contract from your machine |

## Deploying

Netlify settings are included. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the Netlify setup, custom domain and DNS steps, and for deploying, verifying and recording your own contract.

## Project layout

- `src/` app code and tests
- `src/config/network.ts` the one place to change domain, RPC, token and contract addresses
- `contracts/` Solidity sources, ABIs, deploy scripts and deployment records
- `docs/` deployment guide

## Smart contract (optional, not deployed)

`contracts/Veltrio.sol` is a small contract source for you to review and deploy yourself later (see `contracts/README.md`). The app does not use it; transfers go directly to Arc's official USDC contract.

## Testing and limitations

- Automated tests use a mock wallet and an in-memory chain. They do not prove a real onchain transfer works.
- Browser and mobile-wallet testing must be done by you on the deployed site, starting with a very small amount.
- Activity searches recent blocks first and offers "Search older". Reverted transfers made from another device do not appear.
- Nothing is deployed yet: no Netlify site, no domain, no custom contract.
