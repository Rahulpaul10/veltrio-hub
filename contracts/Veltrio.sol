// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Arc Mainnet only (chain ID: 5042). No constructor arguments.
// Compile in Remix with compiler 0.8.28 (EVM version: cancun).
// USDC amounts use six decimals: 1 USDC = 1_000_000 base units.
// Approve this contract to spend USDC before calling pay.
// Status: NOT deployed and NOT audited.

/// @title IERC20Minimal
/// @notice Minimal USDC interface needed by Veltrio.
interface IERC20Minimal {
    /// @notice Returns the token's decimal precision.
    /// @return The number of decimals.
    function decimals() external view returns (uint8);

    /// @notice Transfers approved tokens directly between accounts.
    /// @param from The payer.
    /// @param to The recipient.
    /// @param amount The amount in base units.
    /// @return Whether the transfer succeeded.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title Veltrio
/// @notice Non-custodial USDC payments on Arc Mainnet with an opaque payment reference.
/// @dev Deploy with no constructor arguments on Arc Mainnet only (chain ID 5042).
/// The constructor rejects other networks to protect against wrong-network deployment.
/// Uses the official Arc Mainnet USDC ERC-20 address published at docs.arc.io.
/// USDC amounts use six decimals: 1 USDC = 1_000_000 base units.
/// Approve this contract first, and approve only the amount you intend to spend.
/// Payments go directly from payer to recipient; this helper never takes custody.
/// Arc USDC can revert for blocklisted addresses. Native USDC force-sent here
/// cannot be recovered: there is no admin, recovery function, or payable entry point.
/// There is no mutable accounting state or administrative reentrancy surface.
/// This contract has not been audited or deployed.
contract Veltrio {
    /// @notice The official Arc Mainnet USDC ERC-20 used for payments.
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    /// @notice The only chain ID on which deployment is permitted.
    uint256 public constant ARC_MAINNET_CHAIN_ID = 5042;

    /// @notice USDC decimal precision; 1 USDC equals 1_000_000 base units.
    uint8 public constant USDC_DECIMALS = 6;

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
    /// @notice The recipient is zero, this helper, or the USDC contract.
    /// @param to The rejected recipient.
    error InvalidRecipient(address to);
    /// @notice The payment amount must be greater than zero.
    error ZeroAmount();
    /// @notice The token transfer failed or returned false or malformed ABI data.
    /// @param from The payer.
    /// @param to The recipient.
    /// @param amount The attempted payment in USDC base units.
    error TransferFailed(address from, address to, uint256 amount);

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

    /// @notice Checks Arc Mainnet and the fixed USDC contract; takes no arguments.
    /// @dev Deployment is restricted to Arc Mainnet to prevent wrong-network deployment.
    /// Requires token code and a successful, well-formed six-decimal response.
    constructor() {
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
    /// @dev Requires prior allowance of at least amount. Checks precede interaction;
    /// there are no mutable state effects. Only empty return data or ABI true is accepted.
    /// Arc USDC can revert for blocklisted addresses; failures use TransferFailed.
    /// Solidity reserves `reference`, so the parameter is named paymentReference.
    /// @param to Recipient; cannot be zero, this helper, or the token contract.
    /// @param amount Positive amount in USDC base units (1 USDC = 1_000_000).
    /// @param paymentReference Arbitrary public reference; carries no authorization.
    function pay(address to, uint256 amount, bytes32 paymentReference) external {
        if (to == address(0) || to == address(this) || to == USDC) {
            revert InvalidRecipient(to);
        }
        if (amount == 0) revert ZeroAmount();

        (bool success, bytes memory result) = USDC.call(
            abi.encodeCall(IERC20Minimal.transferFrom, (msg.sender, to, amount))
        );
        if (!success) revert TransferFailed(msg.sender, to, amount);
        if (result.length != 0) {
            // Decode as uint256 so malformed boolean values also use our custom error.
            if (result.length != 32 || abi.decode(result, (uint256)) != 1) {
                revert TransferFailed(msg.sender, to, amount);
            }
        }
        emit Payment(msg.sender, to, paymentReference, amount);
    }
}
