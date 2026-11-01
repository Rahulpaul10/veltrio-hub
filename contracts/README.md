# contracts/

On-chain files for Veltrio, separated by purpose.

| Path | Purpose |
| --- | --- |
| `contracts/Veltrio.sol` | Arc Mainnet contract source. **Not deployed, not audited, not connected to the app** |
| `contracts/test/Veltrio.t.sol` | Foundry tests for `Veltrio.sol` (149 tests including invariants) |
| `contracts/abi/Veltrio.abi.json` | ABI of `Veltrio.sol` (generated from the compiled contract; the app does not import it) |
| `contracts/abi/USDC.abi.json` | ABI of Arc's official USDC ERC-20 interface (used by the app) |
| `contracts/deployments/arc-mainnet.json` | Mainnet deployments and planned constructor argument. **No deployed contract yet** |
| `contracts/deployments/arc-testnet.json` | Arc Testnet deployment of an earlier version. Test only, never mainnet |
| `contracts/script/` | Generic Foundry deploy templates (not needed for Remix) |

Veltrio's Send flow still sends plain USDC straight to the official Arc USDC contract. `Veltrio.sol`
does not replace it and nothing in the app calls it.

## What `Veltrio.sol` does

`pay(to, amount, paymentReference)` moves USDC from the caller straight to `to` and emits
`Payment(from, to, paymentReference, amount)`. The caller must `approve` the contract for at least
`amount` first, so one payment is two wallet transactions (approve, then pay). The contract never
holds funds in normal use. It is built on OpenZeppelin 5.x (`Ownable2Step`, `Pausable`, `SafeERC20`).

Fixed in the source for **Arc Mainnet**:

| Value | Setting |
| --- | --- |
| Chain ID | `5042` (the constructor reverts on any other chain, so it cannot be deployed to the wrong network by mistake) |
| USDC token | `0x3600000000000000000000000000000000000000` (official Arc USDC ERC-20, from <https://docs.arc.io/arc/references/contract-addresses>) |
| USDC decimals | `6`, so 1 USDC = `1_000_000` base units (checked again in the constructor) |
| Constructor argument | **one**: `initialOwner` (see below) |

Arc's native gas balance uses 18 decimals, but the USDC ERC-20 interface this contract calls uses 6.
Amounts you pass to `pay` are always in 6-decimal base units.

## The owner and what the owner can do

The owner is **not written into the source**. You choose it when you deploy, through the single
constructor argument `initialOwner`. The planned value is recorded (as documentation only) in
`contracts/deployments/arc-mainnet.json`:

`0x901f10BC9F2Af3785CF29dDB93A2afe68008D7B2`

The owner can do exactly these things:

| Power | Details |
| --- | --- |
| `pause()` / `unpause()` | Stops `pay` for **at most 3 days**, then payments resume automatically even if the owner key is lost. After any pause ends (early or by expiry) the owner cannot pause again for 1 day, so payments are open at least 1 day in every 4. |
| `rescueToken(token, to, amount)` | Sends a token that was mistakenly sent **to the contract** to a recipient (works for USDC too). |
| `rescueNative(to, amount)` | Sends native USDC that was force-sent to the contract. |
| `transferOwnership` / `acceptOwnership` | Two-step handover: the new owner must accept. |

The owner **cannot** move USDC out of anyone's wallet, cannot spend anyone's allowance, cannot take
fees, cannot upgrade the contract, and cannot renounce ownership (`renounceOwnership` always reverts).
Because the owner controls anything sent *to* the contract, never send funds directly to it.

**Use a safe owner.** A single wallet key is a single point of failure. For real use consider a
multisig as owner (pass its address as `initialOwner`). Whoever controls the owner key can pause
payments up to 75% of the time (3 days on, 1 day off) and can sweep stray balances.

## Pause expiry and events

A pause ends on its own after 3 days, and **no `Unpaused` event is emitted when it does**. (Calling
`unpause()` yourself does emit one.) Do not treat the latest `Paused` event as proof that payments are
currently paused. Anything that reads logs must call `paused()` for the real state; `pausedAt()` and
`pauseLockedUntil()` give the timestamps.

## Compiler settings and dependencies

- Solidity `0.8.28` (exact), EVM version `cancun`, optimizer enabled, `200` runs (matches `foundry.toml`).
- OpenZeppelin Contracts **exactly `5.6.1`** (pinned in `package.json`, no caret; `remappings.txt` maps
  `@openzeppelin/contracts/` to `node_modules`).
- Foundry for the tests (`forge`). Local commands: `bun run contracts:build` and `bun run contracts:test`.

## Open and compile in Remix

1. Open <https://remix.ethereum.org>.
2. In **File explorer**, create `Veltrio.sol`. **Pin OpenZeppelin to 5.6.1**, the version every test and
   review used. By default Remix fetches "latest" from npm, which may differ. Use one of:
   - **Recommended:** run `forge flatten contracts/Veltrio.sol > Veltrio.flat.sol` and paste that single
     file into Remix. It has no imports and contains the pinned 5.6.1 code (on this project it compiles to
     the same runtime bytecode as the normal build, metadata hash excluded). Do not commit the flattened file.
   - Or paste `contracts/Veltrio.sol` and change each import to
     `@openzeppelin/contracts@5.6.1/...`, then check that `.deps/npm/@openzeppelin/contracts@5.6.1/` exists.
3. Open the **Solidity compiler** tab and set compiler `0.8.28`, EVM version `cancun`, optimization
   enabled with `200` runs.
4. Click **Compile Veltrio.sol**.

Remix's built-in simulated network ("Remix VM") has a different chain ID, so deploying there will
fail on purpose with `WrongChain`. That is the safety check working, not a bug.

## Deploying (yours to do, after review)

1. Get an independent professional audit. The checks run in Arc Studio are not an audit.
2. Rehearse on Arc Testnet first. `Veltrio.sol` as written refuses to deploy there, so a testnet
   rehearsal needs a testnet variant of the file; ask for one rather than editing the guard.
3. In Remix **Deploy & run**: Environment `Injected Provider - MetaMask`, MetaMask on **Arc Mainnet
   (chain ID 5042)**, contract `Veltrio`, and set `INITIALOWNER` to your owner address. Check it
   character by character before confirming. Mainnet transactions use real funds and cannot be undone.
   Never put a private key or seed phrase in any file or chat.
4. After the deployment confirms, check on the explorer that `owner()` equals your address, `USDC()` is
   `0x3600…0000`, and `paused()` is `false`. Then record the address and deployment transaction in
   `contracts/deployments/arc-mainnet.json` and verify the source on the Arc explorer. See `docs/DEPLOYMENT.md`.
5. The contract is **not audited and not integrated with the app**: the Send page does not call it. Wiring it in
   is a separate change that needs its own testing. Never put an
   address into the app's config before the contract really exists.

Secrets (deployer keys, keystore names) never belong in these files or in the frontend.
