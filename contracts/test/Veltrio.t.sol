// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Veltrio} from "../Veltrio.sol";

/// @dev Configurable 6-decimal mock token. `mode` alters transferFrom's return behaviour.
contract MockToken {
    enum Mode {
        Normal, // returns true
        ReturnFalse, // returns false
        NoData, // returns no data
        Malformed2, // returns uint256(2)
        Short // returns a single byte
    }

    uint8 public decimals;
    Mode public mode;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        Mode m = mode;
        if (m == Mode.ReturnFalse) return false;
        require(allowance[from][msg.sender] >= amt, "allowance");
        require(balanceOf[from] >= amt, "balance");
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;

        if (m == Mode.NoData) {
            assembly {
                return(0, 0)
            }
        } else if (m == Mode.Malformed2) {
            assembly {
                mstore(0, 2)
                return(0, 32)
            }
        } else if (m == Mode.Short) {
            assembly {
                mstore(0, shl(248, 1))
                return(0, 1)
            }
        }
        return true;
    }
}

/// @dev Token whose decimals() always reverts.
contract RevertingDecimalsToken {
    function decimals() external pure returns (uint8) {
        revert("no decimals");
    }
}

contract VeltrioTest is Test {
    event Payment(address indexed from, address indexed to, bytes32 indexed paymentReference, uint256 amount);

    MockToken internal token;
    Veltrio internal veltrio;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    bytes32 internal constant REF = keccak256("invoice-1");

    function setUp() public {
        token = new MockToken(6);
        veltrio = new Veltrio(address(token));
        token.mint(alice, 1_000e6);
        vm.prank(alice);
        token.approve(address(veltrio), type(uint256).max);
    }

    // ---------------------------------------------------------------- constructor

    function test_Constructor_StoresToken() public view {
        assertEq(veltrio.usdc(), address(token));
    }

    function test_Constructor_RevertsOnZeroAddress() public {
        vm.expectRevert(Veltrio.ZeroTokenAddress.selector);
        new Veltrio(address(0));
    }

    function test_Constructor_RevertsWhenNoCode() public {
        vm.expectRevert(Veltrio.TokenHasNoCode.selector);
        new Veltrio(makeAddr("eoa"));
    }

    function test_Constructor_RevertsOnWrongDecimals() public {
        MockToken t18 = new MockToken(18);
        vm.expectRevert(Veltrio.InvalidTokenDecimals.selector);
        new Veltrio(address(t18));
    }

    function test_Constructor_RevertsWhenDecimalsReverts() public {
        RevertingDecimalsToken bad = new RevertingDecimalsToken();
        vm.expectRevert(Veltrio.InvalidTokenDecimals.selector);
        new Veltrio(address(bad));
    }

    function test_Constructor_RevertsWhenTokenLacksDecimals() public {
        // A contract with code but no decimals() selector (this test contract has no fallback).
        vm.expectRevert(Veltrio.InvalidTokenDecimals.selector);
        new Veltrio(address(this));
    }

    // ---------------------------------------------------------------- pay: happy path

    function test_Pay_MovesBalances() public {
        vm.prank(alice);
        veltrio.pay(bob, 250e6, REF);
        assertEq(token.balanceOf(alice), 750e6);
        assertEq(token.balanceOf(bob), 250e6);
        assertEq(token.allowance(alice, address(veltrio)), type(uint256).max - 250e6);
    }

    function test_Pay_EmitsPayment() public {
        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Payment(alice, bob, REF, 123e6);
        vm.prank(alice);
        veltrio.pay(bob, 123e6, REF);
    }

    function test_Pay_EmitsPaymentWithZeroReference() public {
        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Payment(alice, bob, bytes32(0), 1);
        vm.prank(alice);
        veltrio.pay(bob, 1, bytes32(0));
    }

    function test_Pay_ContractNeverHoldsTokens() public {
        vm.prank(alice);
        veltrio.pay(bob, 500e6, REF);
        assertEq(token.balanceOf(address(veltrio)), 0);
    }

    // ---------------------------------------------------------------- pay: reverts

    function test_Pay_RevertsToZeroAddress() public {
        vm.prank(alice);
        vm.expectRevert(Veltrio.InvalidRecipient.selector);
        veltrio.pay(address(0), 1e6, REF);
    }

    function test_Pay_RevertsToSelf() public {
        vm.prank(alice);
        vm.expectRevert(Veltrio.InvalidRecipient.selector);
        veltrio.pay(address(veltrio), 1e6, REF);
    }

    function test_Pay_RevertsToTokenContract() public {
        vm.prank(alice);
        vm.expectRevert(Veltrio.InvalidRecipient.selector);
        veltrio.pay(address(token), 1e6, REF);
    }

    function test_Pay_RevertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(Veltrio.ZeroAmount.selector);
        veltrio.pay(bob, 0, REF);
    }

    function test_Pay_RevertsOnMissingAllowance() public {
        vm.prank(alice);
        token.approve(address(veltrio), 0);
        vm.prank(alice);
        vm.expectRevert(Veltrio.TransferFailed.selector);
        veltrio.pay(bob, 1e6, REF);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_Pay_RevertsOnInsufficientAllowance() public {
        vm.prank(alice);
        token.approve(address(veltrio), 5e6);
        vm.prank(alice);
        vm.expectRevert(Veltrio.TransferFailed.selector);
        veltrio.pay(bob, 5e6 + 1, REF);
    }

    function test_Pay_RevertsOnInsufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(Veltrio.TransferFailed.selector);
        veltrio.pay(bob, 1_000e6 + 1, REF);
        assertEq(token.balanceOf(alice), 1_000e6);
    }

    function test_Pay_RevertsWhenTransferFromReturnsFalse() public {
        token.setMode(MockToken.Mode.ReturnFalse);
        vm.prank(alice);
        vm.expectRevert(Veltrio.TransferFailed.selector);
        veltrio.pay(bob, 1e6, REF);
    }

    function test_Pay_AcceptsNoReturnData() public {
        token.setMode(MockToken.Mode.NoData);
        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Payment(alice, bob, REF, 10e6);
        vm.prank(alice);
        veltrio.pay(bob, 10e6, REF);
        assertEq(token.balanceOf(bob), 10e6);
    }

    function test_Pay_RejectsMalformedBool() public {
        token.setMode(MockToken.Mode.Malformed2);
        vm.prank(alice);
        vm.expectRevert(Veltrio.TransferFailed.selector);
        veltrio.pay(bob, 1e6, REF);
    }

    function test_Pay_RejectsShortReturnData() public {
        token.setMode(MockToken.Mode.Short);
        vm.prank(alice);
        vm.expectRevert(Veltrio.TransferFailed.selector);
        veltrio.pay(bob, 1e6, REF);
    }

    // ---------------------------------------------------------------- native value

    function test_Pay_RevertsWithNativeValue() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(veltrio).call{value: 1}(abi.encodeCall(Veltrio.pay, (bob, 1e6, REF)));
        assertFalse(ok);
        assertEq(address(veltrio).balance, 0);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_PlainNativeTransferReverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(veltrio).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(veltrio).balance, 0);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_Pay(uint256 amount, bytes32 ref) public {
        amount = bound(amount, 1, 1_000e6);
        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Payment(alice, bob, ref, amount);
        vm.prank(alice);
        veltrio.pay(bob, amount, ref);
        assertEq(token.balanceOf(alice), 1_000e6 - amount);
        assertEq(token.balanceOf(bob), amount);
        assertEq(token.balanceOf(address(veltrio)), 0);
    }

    function testFuzz_Pay_RevertsAboveBalance(uint256 amount, bytes32 ref) public {
        amount = bound(amount, 1_000e6 + 1, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(Veltrio.TransferFailed.selector);
        veltrio.pay(bob, amount, ref);
    }
}
