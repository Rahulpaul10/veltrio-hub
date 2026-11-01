# Veltrio deployment guide

Veltrio runs on **Arc Mainnet only** (chain ID 5042, `0x13B2`). It moves real USDC. Review everything
yourself before you publish it, and test with small amounts first.

Nothing in this repository has been deployed to Netlify or to your domain yet, and no custom smart
contract is deployed. Those steps are yours.

## 1. Where things are configured

| What | Where |
| --- | --- |
| Domain, RPC endpoints, USDC address, deployed contracts | `src/config/network.ts` (reads `.env` and `contracts/deployments/arc-mainnet.json`) |
| Deployed contract addresses | `contracts/deployments/arc-mainnet.json` |
| Contract ABIs | `contracts/abi/*.abi.json` (app copy in `src/abi/`) |
| Solidity sources and deploy scripts | `contracts/` and `contracts/script/` |
| Optional settings and deployment variables | `.env` on your machine only (git-ignored; see the table below) |

Frontend variables start with `VITE_` and are published inside the website. Never put a private key,
seed phrase or API secret in a `VITE_` variable.

The repository intentionally does not include any environment files or templates. Create your own `.env` in the project root (it is git-ignored) with lines in the form
`NAME=value`. Every variable is optional, and none of them may hold a secret value that you would not
publish:

| Name | Where it is used | Notes |
| --- | --- | --- |
| `VITE_SITE_DOMAIN` | Website (public) | Your domain without `https://`, shown in the footer |
| `VITE_RPC_URLS` | Website (public) | Extra https Arc Mainnet RPC endpoints, comma separated. Never include a secret key in the URL. The app checks that each endpoint reports chain 5042 |
| `ARC_MAINNET_RPC_URL` | Your computer only | RPC endpoint for Foundry or scripts when you deploy your own contract |
| `ETH_KEYSTORE_ACCOUNT` | Your computer only | Name of an encrypted keystore account (`cast wallet import`), not a private key |
| `ARC_EXPLORER_VERIFIER_URL` | Your computer only | Verification endpoint, only if the explorer offers a compatible one |

On Netlify, set the two `VITE_` variables under **Project configuration > Environment variables** instead
of using a file.

## 2. Does Veltrio need its own contract?

No. Sending and receiving USDC uses the official USDC contract on Arc:

- Address: `0x3600000000000000000000000000000000000000`
- Interface: ERC-20, **6 decimals** (the same funds are also Arc's gas token at 18 decimals)
- Source: Arc docs, Contract addresses page. The app also checks `decimals()` and `symbol()` on-chain
  before it allows a send.

Deploy a contract only if you add a feature that needs one.

## 3. Deploy your own contract (optional)

Use Arc Foundry (`arc-forge`, `arc-cast`) as recommended by Arc, or standard Foundry.

1. Put the Solidity file in `contracts/` and any deploy script in `contracts/script/`.
2. Import a deployer key into an encrypted keystore, once:
   `cast wallet import deployer --interactive`
3. Put non-secret settings in `.env`: `ARC_MAINNET_RPC_URL=https://rpc.mainnet.arc.io` and
   `ETH_KEYSTORE_ACCOUNT=deployer`.
4. Build and test: `bun run contracts:build` and `bun run contracts:test`.
5. Deploy from your own machine. This sends a real transaction and costs real USDC for gas:

   ```bash
   forge create contracts/YourContract.sol:YourContract \
     --rpc-url "$ARC_MAINNET_RPC_URL" --account "$ETH_KEYSTORE_ACCOUNT" --broadcast
   ```

   Arc enforces a minimum `maxFeePerGas` of 20 gwei. If a transaction is rejected as underpriced, pass
   `--priority-gas-price` / `--gas-price` accordingly.

For `contracts/Veltrio.sol` specifically:

- **Constructor:** one argument, `initialOwner`: the wallet that may pause payments for at most 3 days, sweep
  stray balances and hand over ownership. Planned value `0x901f10BC9F2Af3785CF29dDB93A2afe68008D7B2`; check it
  character by character at deploy time. The owner is not written into the source.
- **Built in:** the Arc Mainnet chain ID (5042), the official USDC address and 6 decimals. It reverts with
  `WrongChain` on any other chain.
- **Compiler:** solc `0.8.28`, EVM `cancun`, optimizer on, `200` runs.
- **OpenZeppelin is pinned to 5.6.1** (exact, in `package.json`), the version all tests and reviews used.
  Do not let Remix pick "latest" from npm. Use one of these:
  1. **Recommended (exact):** run `forge flatten contracts/Veltrio.sol > Veltrio.flat.sol` and paste that single
     file into Remix. It contains the pinned OpenZeppelin 5.6.1 code and has no imports. A check on this
     project showed it compiles to the same runtime bytecode as the normal build (metadata hash excluded).
     Do not commit the flattened file; it is a build output.
  2. **Pinned imports:** in Remix, change each import to
     `@openzeppelin/contracts@5.6.1/...` (for example `@openzeppelin/contracts@5.6.1/access/Ownable.sol`), and
     confirm in the file explorer that `.deps/npm/@openzeppelin/contracts@5.6.1/` exists.
  Verify the deployed source on the explorer with the same file you compiled.
- **With Foundry** the form is `forge create contracts/Veltrio.sol:Veltrio --constructor-args <OWNER_ADDRESS> ...`
  plus the flags shown above.
- **Pause expiry emits no event.** A pause ends on its own after 3 days, and no `Unpaused` event is emitted when
  it does (a manual `unpause()` does emit one). Anything that reads logs, such as an indexer or a monitoring
  script, must call `paused()` for the real state and must not treat the latest `Paused` event as "currently
  paused". `pausedAt()` and `pauseLockedUntil()` give the timestamps.
- **Status:** not deployed and not independently audited. The app does not call this contract. Arc Testnet
  deployments of an earlier version are recorded separately in `contracts/deployments/arc-testnet.json`.

## 4. Verify the contract

Arc's explorer runs Blockscout. Arc's own guide verifies on testnet with the Blockscout verifier. The mainnet
command below follows the same pattern but has not been run by the person who wrote this guide, so
confirm it on https://explorer.arc.io:

```bash
forge verify-contract <DEPLOYED_ADDRESS> contracts/YourContract.sol:YourContract \
  --chain-id 5042 --verifier blockscout --verifier-url https://explorer.arc.io/api/
```

If that fails, use the contract verification page on the explorer and upload the source manually.
Use the same compiler settings as in `foundry.toml`.

## 5. Record the address in the app

Edit `contracts/deployments/arc-mainnet.json`:

```json
{
  "chainId": 5042,
  "network": "Arc Mainnet",
  "contracts": {
    "YourContract": { "address": "0x...", "deployTx": "0x...", "verified": true }
  }
}
```

Then read it in code with `NETWORK.contracts.YourContract` from `src/config/network.ts`. Invalid
addresses stop the app at startup, so a typo cannot go live. Copy the ABI to `contracts/abi/` and
`src/abi/`.

## 6. Publish with Netlify on your own domain

Settings are in `netlify.toml` (build command, publish folder `dist`, single-page-app routing, security
headers, `BUN_VERSION`) and in `public/_redirects` and `public/_headers`. Netlify's documentation
(docs.netlify.com, "Manage build dependencies") states that Bun is exposed at build time, that a committed
`bun.lock`/`bun.lockb` makes Netlify run `bun install`, and that `BUN_VERSION` pins the version. This project
commits `bun.lock`. A real Netlify build has not been run from this project, so watch the first build log.

1. Push the project to a Git repository (never commit `.env`; `.gitignore` already excludes it).
2. In Netlify: **Add new project > Import an existing project**, pick the repository. Build command and
   publish directory (`dist`) come from `netlify.toml`. The build runs the production build and
   then `bun run verify:build`, which fails the deploy if a testnet value or a secret name is in the bundle.
3. In **Project configuration > Environment variables** add `VITE_SITE_DOMAIN` (and optionally
   `VITE_RPC_URLS`). Only public values: they are baked into the website at build time, so re-deploy after
   changing them. Never add a private key or API secret.
4. Add the domain: **Domain management > Add a domain**, e.g. `wallet.example.com`.
5. Configure DNS at your registrar (per Netlify's "Configure external DNS" documentation):
   - **Subdomain** such as `wallet.example.com` or `www.example.com` (recommended by Netlify): add a
     **CNAME** record with the subdomain as host, pointing to `<your-site>.netlify.app`.
   - **Apex domain** such as `example.com`: CNAME is not allowed. If your DNS provider supports
     **ALIAS / ANAME / flattened CNAME**, point it to `apex-loadbalancer.netlify.com` (recommended).
     Otherwise add an **A** record for `@` pointing to `75.2.60.5` (Netlify's published load-balancer IP for
     the standard network; confirm the value Netlify shows in your project, because it can differ for
     other plans). Netlify also adds `www`, which needs its own CNAME. Netlify recommends making the `www`
     (subdomain) version the primary domain.
   - Alternatively move the domain to Netlify DNS and set the nameservers Netlify gives you.
   - DNS changes can take hours to propagate (Netlify says up to a day).
6. After DNS resolves, in **Domain management > HTTPS** click **Verify DNS configuration**, then
   **Provision certificate**. Netlify cannot issue a certificate until DNS points at it.
7. Evidence that the domain is connected: Netlify shows the domain as verified with an active certificate,
   `curl -sI https://your-domain/ | grep -i server` shows `server: Netlify`, and
   `https://your-domain/send` opens the app directly (SPA routing).

The domain is **not** connected until you have seen that evidence. Nothing here has been verified against a
real domain, and no DNS records have been created or changed by this project.

## 7. Before you go live

- `bun run check`, `bun test`, `bun run build`, `bun run verify:build` all pass.
- Send a very small amount of real USDC between two of your own wallets on the deployed site and confirm
  the balance, the fee shown in the wallet, the Activity entry and the explorer link.
- Have the code independently reviewed or audited before you promote it.

## Deploying the website to Vercel

`public/vercel.json` is copied into the build output (`dist/`) and is needed on Vercel. Vercel ignores the
Netlify-style `_redirects` and `_headers` files, so this file supplies the two things the app needs:

- **Rewrites:** every path except `/assets/` serves `index.html`, so direct links and refreshes on `/send`,
  `/receive` and `/activity` work.
- **Security headers:** `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy, a restrictive permissions
  policy, HSTS, and long-lived caching for hashed files in `/assets/`.

Keep it committed. If it is missing, deep links would most likely return a 404 on Vercel and the headers would
not be sent. It is harmless on Netlify, which uses `netlify.toml` and `public/_redirects`.
