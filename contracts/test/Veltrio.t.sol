// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Veltrio} from "../Veltrio.sol";

/// @dev Configurable USDC-like mock. Placed at the fixed USDC address via deployCodeTo.
contract MockUsdc {
    enum Mode {
        Normal, // returns true
        ReturnFalse, // returns false, moves nothing
        NoData, // moves tokens, returns no data
        OneByte, // returns 1 byte
        TwoValue, // returns uint256(2)
        LongData, // returns 64 bytes (first word == 1)
        Revert // reverts with a string
    }

    uint8 public decimals = 6;
    Mode public mode;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    error Blocked(address account);
    error InsufficientAllowance();
    error InsufficientBalance();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (mode == Mode.Revert) revert("token revert");
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        if (mode == Mode.ReturnFalse) return false;
        if (allowance[from][msg.sender] < amount) revert InsufficientAllowance();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (mode == Mode.NoData) {
            assembly {
                return(0, 0)
            }
        } else if (mode == Mode.OneByte) {
            assembly {
                mstore(0, shl(248, 1))
                return(0, 1)
            }
        } else if (mode == Mode.TwoValue) {
            assembly {
                mstore(0, 2)
                return(0, 32)
            }
        } else if (mode == Mode.LongData) {
            assembly {
                mstore(0, 1)
                mstore(32, 0)
                return(0, 64)
            }
        }
        return true;
    }
}

/// @dev Answers EVERY call (incl. decimals()) in a configurable way.
contract MockDecimalsVariant {
    // 0 revert, 1 empty success, 2 one byte, 3 uint256(256), 4 uint256.max,
    // 5 64 bytes (6, 0), 6 uint256(6) control, 7 uint256(18), 8 uint256(255)
    uint256 public variant;

    constructor(uint256 v) {
        variant = v;
    }

    fallback() external {
        uint256 v = variant;
        if (v == 0) {
            revert("no decimals");
        } else if (v == 1) {
            assembly {
                return(0, 0)
            }
        } else if (v == 2) {
            assembly {
                mstore(0, shl(248, 6))
                return(0, 1)
            }
        } else if (v == 3) {
            assembly {
                mstore(0, 256)
                return(0, 32)
            }
        } else if (v == 4) {
            assembly {
                mstore(0, not(0))
                return(0, 32)
            }
        } else if (v == 5) {
            assembly {
                mstore(0, 6)
                mstore(32, 0)
                return(0, 64)
            }
        } else if (v == 6) {
            assembly {
                mstore(0, 6)
                return(0, 32)
            }
        } else if (v == 7) {
            assembly {
                mstore(0, 18)
                return(0, 32)
            }
        } else {
            assembly {
                mstore(0, 255)
                return(0, 32)
            }
        }
    }
}

/// @dev Has no decimals() and no fallback: calling decimals() reverts.
contract MockNoDecimals {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }
}

contract VeltrioTest is Test {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    string internal constant MOCK = "Veltrio.t.sol:MockUsdc";

    Veltrio internal veltrio;
    MockUsdc internal usdc;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    bytes32 internal constant REF = keccak256("invoice-42");

    function setUp() public {
        vm.chainId(5042);
        deployCodeTo(MOCK, USDC);
        usdc = MockUsdc(USDC);
        veltrio = new Veltrio();

        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(address(veltrio), 50e6);
    }

    // ------------------------------------------------------------------
    // Deployment
    // ------------------------------------------------------------------

    function test_Deploy_SucceedsOnArcMainnetWithSixDecimals() public {
        Veltrio v = new Veltrio();
        assertGt(address(v).code.length, 0);
    }

    function test_Constants() public view {
        assertEq(veltrio.USDC(), 0x3600000000000000000000000000000000000000);
        assertEq(veltrio.ARC_MAINNET_CHAIN_ID(), 5042);
        assertEq(uint256(veltrio.USDC_DECIMALS()), 6);
    }

    function test_Deploy_RevertsOnEthereumMainnet() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.WrongChain.selector, uint256(1)));
        new Veltrio();
    }

    function test_Deploy_RevertsOnArcTestnet() public {
        vm.chainId(5042002);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.WrongChain.selector, uint256(5042002)));
        new Veltrio();
    }

    function test_Deploy_RevertsOnLocalChain() public {
        vm.chainId(31337);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.WrongChain.selector, uint256(31337)));
        new Veltrio();
    }

    function testFuzz_Deploy_RevertsOnAnyOtherChain(uint64 chainId) public {
        vm.assume(chainId != 5042 && chainId != 0);
        vm.chainId(chainId);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.WrongChain.selector, uint256(chainId)));
        new Veltrio();
    }

    function test_Deploy_RevertsWhenTokenHasNoCode() public {
        vm.etch(USDC, "");
        vm.expectRevert(Veltrio.TokenHasNoCode.selector);
        new Veltrio();
    }

    function test_Deploy_RevertsWhenDecimalsIs18() public {
        usdc.setDecimals(18);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidTokenDecimals.selector, uint8(18)));
        new Veltrio();
    }

    function test_Deploy_RevertsWhenDecimalsIs0() public {
        usdc.setDecimals(0);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidTokenDecimals.selector, uint8(0)));
        new Veltrio();
    }

    function test_Deploy_RevertsWhenDecimalsIs255() public {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(uint256(8)), USDC);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidTokenDecimals.selector, uint8(255)));
        new Veltrio();
    }

    function test_Deploy_RevertsWhenDecimalsCallReverts() public {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(uint256(0)), USDC);
        vm.expectRevert(Veltrio.TokenDecimalsCallFailed.selector);
        new Veltrio();
    }

    function test_Deploy_RevertsWhenDecimalsMissing() public {
        deployCodeTo("Veltrio.t.sol:MockNoDecimals", USDC);
        vm.expectRevert(Veltrio.TokenDecimalsCallFailed.selector);
        new Veltrio();
    }

    function test_Deploy_RevertsWhenDecimalsReturnsEmptyData() public {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(uint256(1)), USDC);
        vm.expectRevert(Veltrio.TokenDecimalsCallFailed.selector);
        new Veltrio();
    }

    function test_Deploy_RevertsWhenDecimalsReturnsShortData() public {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(uint256(2)), USDC);
        vm.expectRevert(Veltrio.TokenDecimalsCallFailed.selector);
        new Veltrio();
    }

    function test_Deploy_RevertsWhenDecimalsReturnsLongData() public {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(uint256(5)), USDC);
        vm.expectRevert(Veltrio.TokenDecimalsCallFailed.selector);
        new Veltrio();
    }

    function test_Deploy_RevertsWhenDecimalsAbove255() public {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(uint256(3)), USDC);
        vm.expectRevert(Veltrio.TokenDecimalsCallFailed.selector);
        new Veltrio();
    }

    function test_Deploy_RevertsWhenDecimalsIsUint256Max() public {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(uint256(4)), USDC);
        vm.expectRevert(Veltrio.TokenDecimalsCallFailed.selector);
        new Veltrio();
    }

    function test_Deploy_SucceedsWithMinimalSixDecimalsToken() public {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(uint256(6)), USDC);
        Veltrio v = new Veltrio();
        assertGt(address(v).code.length, 0);
    }

    // ------------------------------------------------------------------
    // pay: happy path
    // ------------------------------------------------------------------

    function test_Pay_MovesBalancesDirectlyAndDecrementsAllowance() public {
        vm.prank(alice);
        veltrio.pay(bob, 10e6, REF);

        assertEq(usdc.balanceOf(alice), 90e6);
        assertEq(usdc.balanceOf(bob), 10e6);
        assertEq(usdc.allowance(alice, address(veltrio)), 40e6);
        assertEq(usdc.balanceOf(address(veltrio)), 0);
        assertEq(address(veltrio).balance, 0);
    }

    function test_Pay_EmitsExactPaymentEvent() public {
        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Veltrio.Payment(alice, bob, REF, 7e6);
        vm.prank(alice);
        veltrio.pay(bob, 7e6, REF);
    }

    function test_Pay_EmitsExactlyOneEventFromVeltrio() public {
        vm.recordLogs();
        vm.prank(alice);
        veltrio.pay(bob, 3e6, REF);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(veltrio)) {
                count++;
                assertEq(logs[i].topics.length, 4);
                assertEq(logs[i].topics[0], Veltrio.Payment.selector);
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(alice))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(bob))));
                assertEq(logs[i].topics[3], REF);
                assertEq(abi.decode(logs[i].data, (uint256)), 3e6);
            }
        }
        assertEq(count, 1);
    }

    function test_Pay_OneUsdcIsOneMillionBaseUnits() public {
        uint256 oneUsdc = 1_000_000;
        assertEq(oneUsdc, 10 ** uint256(veltrio.USDC_DECIMALS()));
        vm.prank(alice);
        veltrio.pay(bob, oneUsdc, REF);
        assertEq(usdc.balanceOf(bob), 1_000_000);
        assertEq(usdc.balanceOf(alice), 99_000_000);
    }

    function test_Pay_SmallestUnitAndFullAllowance() public {
        vm.prank(alice);
        veltrio.pay(bob, 1, REF);
        assertEq(usdc.balanceOf(bob), 1);

        vm.prank(alice);
        veltrio.pay(bob, 50e6 - 1, bytes32(0));
        assertEq(usdc.balanceOf(bob), 50e6);
        assertEq(usdc.allowance(alice, address(veltrio)), 0);
    }

    function test_Pay_AllowsZeroReference() public {
        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Veltrio.Payment(alice, bob, bytes32(0), 1e6);
        vm.prank(alice);
        veltrio.pay(bob, 1e6, bytes32(0));
    }

    function test_Pay_AllowsSelfPayment() public {
        vm.prank(alice);
        veltrio.pay(alice, 5e6, REF);
        assertEq(usdc.balanceOf(alice), 100e6);
    }

    function test_Pay_AcceptsTokenReturningNoData() public {
        usdc.setMode(MockUsdc.Mode.NoData);
        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Veltrio.Payment(alice, bob, REF, 4e6);
        vm.prank(alice);
        veltrio.pay(bob, 4e6, REF);
        assertEq(usdc.balanceOf(bob), 4e6);
    }

    // ------------------------------------------------------------------
    // pay: reverts
    // ------------------------------------------------------------------

    function test_Pay_RevertsForZeroRecipient() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidRecipient.selector, address(0)));
        veltrio.pay(address(0), 1e6, REF);
    }

    function test_Pay_RevertsForVeltrioRecipient() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidRecipient.selector, address(veltrio)));
        veltrio.pay(address(veltrio), 1e6, REF);
    }

    function test_Pay_RevertsForUsdcRecipient() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidRecipient.selector, USDC));
        veltrio.pay(USDC, 1e6, REF);
    }

    function test_Pay_RevertsForZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(Veltrio.ZeroAmount.selector);
        veltrio.pay(bob, 0, REF);
    }

    function test_Pay_InvalidRecipientCheckedBeforeZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidRecipient.selector, address(0)));
        veltrio.pay(address(0), 0, REF);
    }

    function test_Pay_RevertsWithoutAllowance() public {
        address carol = makeAddr("carol");
        usdc.mint(carol, 10e6);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, carol, bob, 1e6));
        veltrio.pay(bob, 1e6, REF);
    }

    function test_Pay_RevertsWhenAllowanceTooLow() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, alice, bob, 50e6 + 1));
        veltrio.pay(bob, 50e6 + 1, REF);
    }

    function test_Pay_RevertsWhenBalanceTooLow() public {
        vm.prank(alice);
        usdc.approve(address(veltrio), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, alice, bob, 100e6 + 1));
        veltrio.pay(bob, 100e6 + 1, REF);
    }

    function test_Pay_RevertsWhenTokenReturnsFalse() public {
        usdc.setMode(MockUsdc.Mode.ReturnFalse);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, alice, bob, 1e6));
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_Pay_RevertsWhenTokenReturnsOneByte() public {
        usdc.setMode(MockUsdc.Mode.OneByte);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, alice, bob, 1e6));
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_Pay_RevertsWhenTokenReturnsTwo() public {
        usdc.setMode(MockUsdc.Mode.TwoValue);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, alice, bob, 1e6));
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_Pay_RevertsWhenTokenReturnsLongData() public {
        usdc.setMode(MockUsdc.Mode.LongData);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, alice, bob, 1e6));
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_Pay_RevertsWhenTokenReverts() public {
        usdc.setMode(MockUsdc.Mode.Revert);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, alice, bob, 1e6));
        veltrio.pay(bob, 1e6, REF);
    }

    function test_Pay_RevertsWhenPayerBlocklisted() public {
        usdc.setBlocked(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, alice, bob, 1e6));
        veltrio.pay(bob, 1e6, REF);
    }

    function test_Pay_RevertsWhenRecipientBlocklisted() public {
        usdc.setBlocked(bob, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, alice, bob, 1e6));
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(alice), 100e6);
    }

    // ------------------------------------------------------------------
    // Native value
    // ------------------------------------------------------------------

    function test_Pay_RevertsWithNativeValue() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(veltrio).call{value: 1}(abi.encodeCall(Veltrio.pay, (bob, 1e6, REF)));
        assertFalse(ok);
        assertEq(address(veltrio).balance, 0);
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_PlainNativeTransferReverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(veltrio).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(veltrio).balance, 0);
    }

    function test_UnknownSelectorReverts() public {
        (bool ok,) = address(veltrio).call(hex"deadbeef");
        assertFalse(ok);
    }

    // ------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------

    function testFuzz_Pay(uint256 amount, bytes32 ref) public {
        amount = bound(amount, 1, 50e6);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Veltrio.Payment(alice, bob, ref, amount);
        vm.prank(alice);
        veltrio.pay(bob, amount, ref);

        assertEq(usdc.balanceOf(alice), aliceBefore - amount);
        assertEq(usdc.balanceOf(bob), amount);
        assertEq(usdc.allowance(alice, address(veltrio)), 50e6 - amount);
        assertEq(usdc.balanceOf(address(veltrio)), 0);
    }

    function testFuzz_Pay_RevertsAboveAllowance(uint256 amount, bytes32 ref) public {
        amount = bound(amount, 50e6 + 1, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.TransferFailed.selector, alice, bob, amount));
        veltrio.pay(bob, amount, ref);
    }

    function testFuzz_Pay_AnyValidRecipient(address to, uint256 amount, bytes32 ref) public {
        vm.assume(to != address(0) && to != address(veltrio) && to != USDC && to != alice);
        amount = bound(amount, 1, 50e6);
        vm.prank(alice);
        veltrio.pay(to, amount, ref);
        assertEq(usdc.balanceOf(to), amount);
    }
}
