# Veltrio release checklist

Status key: [x] done and evidenced in this repository, [ ] you must do it, [~] partly verified.

## Automated (re-run before every release)

- [x] `bun run check` (lint + typecheck for app and tests)
- [x] `bun test` (unit, RPC, receipt and whole-app tests with a mock wallet and in-memory chain)
- [x] `bun run build`
- [x] `bun run verify:build` (no testnet strings, no secret names, Arc Mainnet values present, SPA files present)

## Configuration facts (checked against Arc docs and live reads)

- [x] Chain ID 5042 (`0x13B2`), RPC `https://rpc.mainnet.arc.io` answers `eth_chainId = 0x13b2`
- [x] Explorer `https://explorer.arc.io`
- [x] USDC `0x3600000000000000000000000000000000000000`: on-chain `decimals()` = 6, `symbol()` = USDC; same address in Arc's Contract addresses page
- [x] Real mainnet receipts contain the USDC contract's 3-topic Transfer log used for receipt verification (read-only lookup)
- [ ] Re-check these on release day if Arc announces changes

## Manual: must be done by you (nothing below has been run)

- [ ] Review the code or get an independent audit before promoting it. It moves real USDC and is irreversible.
- [ ] Create the Netlify project from your repository; read the first build log (Bun install, `verify:build`)
- [ ] Set `VITE_SITE_DOMAIN` (and `VITE_RPC_URLS` if you use your own RPC) in Netlify, then redeploy
- [ ] Add the domain, create the DNS records Netlify shows, verify DNS, provision the certificate (docs/DEPLOYMENT.md section 6)
- [ ] Open `https://your-domain/send`, `/receive`, `/activity` directly and refresh each: no 404
- [ ] Response headers show `server: Netlify`, `x-frame-options`, `x-content-type-options`
- [ ] Desktop wallet test with a very small real amount between two wallets you own: connect, wrong-network prompt, send, wallet shows fee, pending then confirmed, balance updates, Activity entry, explorer link
- [ ] Reject a transfer in the wallet: nothing sent, clear message
- [ ] Mobile wallet test (wallet app browser and, if you want it, a mobile browser with a wallet extension): connect, switch network, send, receive. Simulated viewports in desktop dev tools are not a wallet test.
- [ ] Receive: copy the address, send a small amount to it from another wallet, see it in Activity
- [ ] Open the site with the wallet on another network (for example Ethereum): the switch prompt appears and Send is blocked
- [ ] Optional hardening: add a `Content-Security-Policy` header. Not enabled by default because it could not be tested in a real browser here. A starting point to test on a staging site first:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'`

## Known limitations

- Activity searches recent blocks first (about 30 hours), then "Search older". Failed transfers made from another device are not shown (they emit no transfer log).
- Only browser-injected wallets (EIP-1193 / EIP-6963). No WalletConnect.
- The footer/watermark "Built with Arc Studio" link is part of the template.
- `bun audit` reports advisories in transitive dependencies of packages that come with the template (Circle SDKs, WalletConnect tooling). None of those packages are imported by Veltrio, and a string search of the production bundle found no code from the flagged packages. This is indicative, not a proof. Run `bun audit` again before release.
