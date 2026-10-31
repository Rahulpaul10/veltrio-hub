# contracts/

On-chain files for Veltrio, separated by purpose.

| Path | Purpose |
| --- | --- |
| `contracts/Veltrio.sol` | Your own contract (not deployed, not connected to the app) |
| `contracts/test/Veltrio.t.sol` | Foundry unit tests for `Veltrio.sol` |
| `contracts/abi/Veltrio.abi.json` | ABI of `Veltrio.sol` (for later use; the app does not import it) |
| `contracts/abi/USDC.abi.json` | ABI of Arc's official USDC ERC-20 interface (used by the app) |
| `contracts/deployments/arc-mainnet.json` | Where deployed contracts are recorded. Empty until you deploy |
| `contracts/script/` | Generic Foundry deploy templates (not needed for Remix) |

Veltrio's Send flow still sends plain USDC to the official Arc USDC contract
(`0x3600000000000000000000000000000000000000`). `Veltrio.sol` does not replace it.

## What `Veltrio.sol` does

A tiny, non-custodial payment-reference helper. `pay(to, amount, paymentReference)` moves USDC from
the caller straight to `to` (the caller must `approve` the contract first) and emits a
`Payment(from, to, paymentReference, amount)` event. It never holds funds and has no owner, admin,
pause, upgrade or fee logic. The constructor takes the USDC token address and refuses a zero
address, an address without code, or a token that does not report 6 decimals. No address is
hard-coded in the source.

## Open and compile in Remix

1. Open <https://remix.ethereum.org>.
2. In **File explorer**, create `Veltrio.sol` and paste the contents of `contracts/Veltrio.sol`
   (or use **Import from GitHub** once the file is pushed).
3. Open the **Solidity compiler** tab and set:
   - Compiler: `0.8.28`
   - EVM version: `cancun`
   - Optimization: enabled, `200` runs (matches `foundry.toml`)
4. Click **Compile Veltrio.sol**. It has no imports, so nothing else is needed.
5. Read the code and the NatSpec comments in Remix before going further.

The same file also compiles locally: `bun run contracts:build` and `bun run contracts:test`.

## Before you deploy later

- Get an independent review. Automated tests and the checks run here are not a substitute.
- Rehearse first on Arc Testnet (chain ID 5042002) with testnet USDC, which uses the same USDC
  address. Mainnet deployments use real funds and cannot be undone.
- In Remix **Deploy & run**: Environment `Injected Provider - MetaMask`, MetaMask on the intended
  Arc network, contract `Veltrio`, constructor argument = the official USDC address from
  <https://docs.arc.io/arc/references/contract-addresses> (mainnet: `0x3600000000000000000000000000000000000000`).
  Check the address character by character before you confirm.
- After deploying, record the address and transaction hash in `contracts/deployments/arc-mainnet.json`
  under `contracts` (for example `"Veltrio": { "address": "0x...", "deployTx": "0x...", "verified": false }`),
  and verify the source on the Arc explorer. Details: `docs/DEPLOYMENT.md`.
- Using `pay` from a wallet needs two transactions: `approve` on USDC, then `pay`.
- The app does not use this contract yet. Wiring it in is a separate change that needs its own
  testing; never put an address into the app's config before the contract really exists.

Secrets (deployer keys, keystore names) never belong in these files or in the frontend.
