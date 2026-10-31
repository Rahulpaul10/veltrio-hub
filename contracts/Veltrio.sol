// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Compile in Remix with compiler 0.8.28 (EVM version: cancun).
// Constructor argument: the official Arc Mainnet USDC address (see docs.arc.io, Contract addresses).
// Status: NOT deployed and NOT independently audited.

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
/// @notice Non-custodial USDC payments with an opaque payment reference.
/// @dev Pass the Arc Mainnet USDC address published at docs.arc.io at deployment.
/// Decimal precision and code checks do not establish that a token is official USDC.
/// Approve this contract first, and approve only the amount you intend to spend.
/// Payments go directly from payer to recipient; this helper never takes custody.
/// Arc USDC can revert for blocklisted addresses. Native USDC force-sent here
/// cannot be recovered: there is no admin, recovery function, or payable entry point.
/// There is no mutable accounting state or administrative reentrancy surface.
contract Veltrio {
    /// @notice The token used for payments, fixed at deployment.
    address public immutable usdc;

    error ZeroTokenAddress();
    error TokenHasNoCode();
    error InvalidTokenDecimals();
    error InvalidRecipient();
    error ZeroAmount();
    error TransferFailed();

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

    /// @notice Sets and checks the token address.
    /// @dev Use the official Arc Mainnet USDC address from docs.arc.io.
    /// @param usdc_ The token contract, which must have code and six decimals.
    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroTokenAddress();
        if (usdc_.code.length == 0) revert TokenHasNoCode();
        try IERC20Minimal(usdc_).decimals() returns (uint8 precision) {
            if (precision != 6) revert InvalidTokenDecimals();
        } catch {
            revert InvalidTokenDecimals();
        }
        usdc = usdc_;
    }

    /// @notice Pays USDC directly to a recipient and records a reference.
    /// @dev Requires prior allowance of at least amount. Checks precede interaction;
    /// there are no mutable state effects. Empty return data or ABI true is accepted.
    /// Solidity reserves `reference`, so the parameter is named paymentReference.
    /// @param to Recipient; cannot be zero, this helper, or the token contract.
    /// @param amount Positive amount in USDC base units (six decimals).
    /// @param paymentReference Arbitrary public reference; carries no authorization.
    function pay(address to, uint256 amount, bytes32 paymentReference) external {
        if (to == address(0) || to == address(this) || to == usdc) {
            revert InvalidRecipient();
        }
        if (amount == 0) revert ZeroAmount();

        (bool success, bytes memory result) = usdc.call(
            abi.encodeCall(IERC20Minimal.transferFrom, (msg.sender, to, amount))
        );
        if (!success) revert TransferFailed();
        if (result.length != 0) {
            // Decode as uint256 so malformed boolean values also use our custom error.
            if (result.length < 32 || abi.decode(result, (uint256)) != 1) {
                revert TransferFailed();
            }
        }
        emit Payment(msg.sender, to, paymentReference, amount);
    }
}
