# contracts/

On-chain files for Veltrio, separated by purpose.

| Path | Purpose |
| --- | --- |
| `contracts/Veltrio.sol` | Arc Mainnet contract source. **Not deployed, not audited, not connected to the app** |
| `contracts/test/Veltrio.t.sol` | Foundry unit tests for `Veltrio.sol` (47 tests) |
| `contracts/abi/Veltrio.abi.json` | ABI of `Veltrio.sol` (for later use; the app does not import it) |
| `contracts/abi/USDC.abi.json` | ABI of Arc's official USDC ERC-20 interface (used by the app) |
| `contracts/deployments/arc-mainnet.json` | Mainnet deployments. **Empty** until you deploy |
| `contracts/deployments/arc-testnet.json` | Arc Testnet deployment of an earlier version. Test only, never mainnet |
| `contracts/script/` | Generic Foundry deploy templates (not needed for Remix) |

Veltrio's Send flow still sends plain USDC straight to the official Arc USDC contract. `Veltrio.sol`
does not replace it and nothing in the app calls it.

## What `Veltrio.sol` does

A tiny payment-reference helper. `pay(to, amount, paymentReference)` moves USDC from the caller
straight to `to` and emits `Payment(from, to, paymentReference, amount)`. The caller must `approve`
the contract for at least `amount` first, so one payment is two wallet transactions (approve, then pay).
It never holds funds and has no owner, admin, pause, upgrade, fee or payable logic.

Fixed in the source for **Arc Mainnet**:

| Value | Setting |
| --- | --- |
| Chain ID | `5042` (the constructor reverts on any other chain, so it cannot be deployed to the wrong network by mistake) |
| USDC token | `0x3600000000000000000000000000000000000000` (official Arc USDC ERC-20, from <https://docs.arc.io/arc/references/contract-addresses>) |
| USDC decimals | `6`, so 1 USDC = `1_000_000` base units (checked again in the constructor) |
| Constructor arguments | none |

Arc's native gas balance uses 18 decimals, but the USDC ERC-20 interface this contract calls uses 6.
Amounts you pass to `pay` are always in 6-decimal base units.

## Open and compile in Remix

1. Open <https://remix.ethereum.org>.
2. In **File explorer**, create `Veltrio.sol` and paste the contents of `contracts/Veltrio.sol`.
3. Open the **Solidity compiler** tab and set compiler `0.8.28`, EVM version `cancun`, optimization
   enabled with `200` runs (matches `foundry.toml`).
4. Click **Compile Veltrio.sol**. It has no imports.
5. Read the comments in the file before going further.

Remix's built-in simulated network ("Remix VM") has a different chain ID, so deploying there will
fail on purpose with `WrongChain`. That is the safety check working, not a bug.

The same file compiles and is tested locally: `bun run contracts:build` and `bun run contracts:test`.

## Remaining steps before a mainnet deployment (yours to do)

1. Get an independent professional audit. The checks run in Arc Studio are not an audit.
2. Rehearse the same flow on Arc Testnet first. `Veltrio.sol` as written refuses to deploy there, so
   rehearse with the earlier testnet version in git history (commit `58aee1a`) or ask for a
   testnet variant. Do not copy a testnet address into mainnet files.
3. Deploy from your own wallet: Remix **Deploy & run**, Environment `Injected Provider - MetaMask`,
   MetaMask on **Arc Mainnet (chain ID 5042)**, contract `Veltrio`, no constructor arguments.
   Mainnet transactions use real funds and cannot be undone.
4. Record the address and deployment transaction in `contracts/deployments/arc-mainnet.json`, and
   verify the source on the Arc explorer. Details: `docs/DEPLOYMENT.md`.
5. Wiring the contract into the app is a separate change that needs its own testing. Never put an
   address into the app's config before the contract really exists.

Secrets (deployer keys, keystore names) never belong in these files or in the frontend.
