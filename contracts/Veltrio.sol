// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Arc Mainnet only (chain ID: 5042). Constructor takes ONE argument: initialOwner.
// Compile with compiler 0.8.28 (EVM version: cancun).
// Imports OpenZeppelin Contracts 5.x (installed version: 5.6.1).
// USDC amounts use six decimals: 1 USDC = 1_000_000 base units.
// Approve this contract to spend USDC before calling pay.
// Status: NOT deployed, NOT audited.

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title IERC20Minimal
/// @notice Minimal decimal-precision interface needed by Veltrio.
interface IERC20Minimal {
    /// @notice Returns the token's decimal precision.
    /// @return The number of decimals.
    function decimals() external view returns (uint8);
}

/// @title Veltrio
/// @notice Non-custodial USDC payments on Arc Mainnet with an opaque payment reference.
/// @dev Deploy with ONE constructor argument, initialOwner, on Arc Mainnet only (5042).
/// The constructor rejects other networks to protect against wrong-network deployment.
/// Uses the official Arc Mainnet USDC ERC-20 address published at docs.arc.io.
/// USDC amounts use six decimals: 1 USDC = 1_000_000 base units.
/// Payments go directly from payer to recipient; this helper never takes custody.
/// Arc USDC can revert for blocklisted addresses. No payable entry point exists.
/// Trust model: the owner can pause payments for at most 3 days and sweep stray
/// contract balances, but cannot touch funds in users' wallets or spend their allowances.
/// Payments resume automatically after 3 days even if the owner key is lost.
/// After any pause ends, early or on expiry, the owner cannot pause again for at least
/// 1 day, so payments are guaranteed to be open at least 1 day in every 4.
/// Ownership and rescue operations are unaffected by pauses.
/// Tokens or native USDC sent directly to this contract are under owner control
/// via the rescue functions; users should never send funds to this contract directly.
/// Users should approve only what they intend to spend. Ownership transfers require acceptance.
/// This contract is NOT deployed, NOT audited.
contract Veltrio is Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    /// @notice The official Arc Mainnet USDC ERC-20 used for payments.
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    /// @notice The only chain ID on which deployment is permitted.
    uint256 public constant ARC_MAINNET_CHAIN_ID = 5042;

    /// @notice USDC decimal precision; 1 USDC equals 1_000_000 base units.
    uint8 public constant USDC_DECIMALS = 6;

    /// @notice Maximum payment pause; payments resume automatically after 3 days.
    uint256 public constant MAX_PAUSE_DURATION = 3 days;

    /// @notice Mandatory unpaused interval after every pause (early resume or expiry).
    uint256 public constant PAUSE_COOLDOWN = 1 days;

    /// @notice Timestamp at which the most recent pause began.
    uint256 public pausedAt;

    /// @notice Earliest timestamp at which the owner may pause again.
    uint256 public pauseLockedUntil;

    /// @notice Deployment was attempted on an unsupported chain.
    /// @param chainId The chain ID on which deployment was attempted.
    error WrongChain(uint256 chainId);
    /// @notice The fixed USDC address has no contract code.
    error TokenHasNoCode();
    /// @notice USDC reported an unexpected decimal precision.
    /// @param decimals The precision reported by USDC.
    error InvalidTokenDecimals(uint8 decimals);
    /// @notice The decimals call failed or returned malformed ABI data.
    error TokenDecimalsCallFailed();
    /// @notice The recipient is zero or this helper; payments also reject USDC.
    /// @param to The rejected recipient.
    error InvalidRecipient(address to);
    /// @notice The payment or rescue amount must be greater than zero.
    error ZeroAmount();
    /// @notice The native USDC transfer failed.
    error NativeTransferFailed();
    /// @notice The requested native USDC amount exceeds this contract's balance.
    /// @param balance The available native balance in base units.
    /// @param requested The requested native amount in base units.
    error InsufficientNativeBalance(uint256 balance, uint256 requested);
    /// @notice Ownership renunciation is disabled to preserve emergency recovery.
    error RenounceDisabled();
    /// @notice The owner must wait before pausing again.
    /// @param lockedUntil The earliest timestamp at which another pause is allowed.
    error PauseCooldown(uint256 lockedUntil);

    /// @notice Emitted only after a successful token transfer.
    /// @param from The payer.
    /// @param to The recipient.
    /// @param paymentReference An opaque reference; not a unique or replay-protected ID.
    /// @param amount The payment amount in USDC base units (six decimals).
    event Payment(
        address indexed from,
        address indexed to,
        bytes32 indexed paymentReference,
        uint256 amount
    );

    /// @notice Emitted after stray ERC-20 tokens are rescued from this contract.
    /// @param token The rescued token contract.
    /// @param to The recipient.
    /// @param amount The amount in the rescued token's base units.
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitted after force-sent native USDC is rescued from this contract.
    /// @param to The recipient.
    /// @param amount The amount in native base units.
    event NativeRescued(address indexed to, uint256 amount);

    /// @notice Checks Arc Mainnet and the fixed USDC contract; sets the initial owner.
    /// @dev Deployment is restricted to Arc Mainnet to prevent wrong-network deployment.
    /// Requires token code and a successful, well-formed six-decimal response.
    /// OpenZeppelin Ownable rejects a zero initial owner.
    /// @param initialOwner The initial administrator; the sole constructor argument.
    constructor(address initialOwner) Ownable(initialOwner) {
        if (block.chainid != ARC_MAINNET_CHAIN_ID) revert WrongChain(block.chainid);
        if (USDC.code.length == 0) revert TokenHasNoCode();

        (bool success, bytes memory result) = USDC.staticcall(
            abi.encodeCall(IERC20Minimal.decimals, ())
        );
        if (!success || result.length != 32) revert TokenDecimalsCallFailed();
        uint256 precision = abi.decode(result, (uint256));
        if (precision > type(uint8).max) revert TokenDecimalsCallFailed();
        if (precision != USDC_DECIMALS) revert InvalidTokenDecimals(uint8(precision));
    }

    /// @notice Pays USDC directly to a recipient and records a reference.
    /// @dev Requires prior allowance of at least amount and payments to be unpaused.
    /// SafeERC20 handles token return data and bubbles underlying token reverts.
    /// Arc USDC can revert for blocklisted addresses.
    /// Solidity reserves `reference`, so the parameter is named paymentReference.
    /// @param to Recipient; cannot be zero, this helper, or the token contract.
    /// @param amount Positive amount in USDC base units (1 USDC = 1_000_000).
    /// @param paymentReference Arbitrary public reference; carries no authorization.
    function pay(address to, uint256 amount, bytes32 paymentReference) external whenNotPaused {
        if (to == address(0) || to == address(this) || to == USDC) {
            revert InvalidRecipient(to);
        }
        if (amount == 0) revert ZeroAmount();

        IERC20(USDC).safeTransferFrom(msg.sender, to, amount);
        emit Payment(msg.sender, to, paymentReference, amount);
    }

    /// @notice Returns whether payments are paused and the 3-day limit has not elapsed.
    /// @dev Expiry resumes payments automatically even if the owner key is lost.
    /// @return True only while an OpenZeppelin pause remains unexpired.
    function paused() public view override returns (bool) {
        return super.paused() && block.timestamp < pausedAt + MAX_PAUSE_DURATION;
    }

    /// @notice Stops payments for at most 3 days; callable only by the owner.
    /// @dev Emits OpenZeppelin Paused; reverts with EnforcedPause if already paused, or
    /// PauseCooldown during the mandatory 1-day unpaused interval after a previous pause.
    /// Rescue and ownership operations remain available while paused.
    function pause() external onlyOwner {
        _requireNotPaused();
        if (block.timestamp < pauseLockedUntil) revert PauseCooldown(pauseLockedUntil);
        _pause();
        pausedAt = block.timestamp;
        pauseLockedUntil = block.timestamp + MAX_PAUSE_DURATION + PAUSE_COOLDOWN;
    }

    /// @notice Resumes payments early; callable only by the owner.
    /// @dev Emits OpenZeppelin Unpaused; reverts with ExpectedPause if not paused or expired.
    /// Starts the mandatory 1-day unpaused interval, so unpause-then-pause cannot keep
    /// payments closed continuously.
    function unpause() external onlyOwner {
        _unpause();
        pauseLockedUntil = block.timestamp + PAUSE_COOLDOWN;
    }

    /// @notice Rescues stray ERC-20 balances held by this contract, including USDC.
    /// @dev Owner-only; transfers solely from this contract, never from users.
    /// SafeERC20 rejects failed transfers and bubbles underlying token reverts.
    /// @param token The ERC-20 contract whose stray balance is being rescued.
    /// @param to Recipient; cannot be zero or this helper.
    /// @param amount Positive amount in the token's base units.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0) || to == address(this)) revert InvalidRecipient(to);
        if (amount == 0) revert ZeroAmount();

        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Rescues native USDC force-sent to this contract; callable only by the owner.
    /// @dev Sends only an existing contract balance; this function is not payable.
    /// @param to Recipient; cannot be zero or this helper.
    /// @param amount Positive amount in native base units, no greater than the balance.
    function rescueNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0) || to == address(this)) revert InvalidRecipient(to);
        if (amount == 0) revert ZeroAmount();
        uint256 balance = address(this).balance;
        if (amount > balance) revert InsufficientNativeBalance(balance, amount);

        (bool success, ) = to.call{value: amount}("");
        if (!success) revert NativeTransferFailed();
        emit NativeRescued(to, amount);
    }

    /// @notice Always rejects ownership renunciation so a paused helper retains an owner.
    /// @dev Reverts with RenounceDisabled for every caller; ownership is unchanged.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
