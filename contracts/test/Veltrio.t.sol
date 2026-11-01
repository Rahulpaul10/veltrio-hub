// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return _ret();
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (mode != Mode.Revert && mode != Mode.ReturnFalse) {
            if (!blocked[from] && !blocked[to]) {
                if (allowance[from][msg.sender] < amount) revert InsufficientAllowance();
            }
        }
        if (mode == Mode.Revert) revert("token revert");
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        if (mode == Mode.ReturnFalse) return false;
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return _ret();
    }

    function _move(address from, address to, uint256 amount) internal {
        if (mode == Mode.Revert) revert("token revert");
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        if (mode == Mode.ReturnFalse) return;
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function _ret() internal view returns (bool) {
        if (mode == Mode.ReturnFalse) return false;
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

/// @dev Native recipient that rejects every incoming transfer.
contract RejectNative {
    receive() external payable {
        revert("no native");
    }
}

/// @dev Contract owner that can chain unpause() and pause() inside ONE transaction.
contract OwnerCycler {
    function pause(Veltrio v) external {
        v.pause();
    }

    function unpause(Veltrio v) external {
        v.unpause();
    }

    /// Reverts as a whole if the inner pause() reverts.
    function unpauseThenPause(Veltrio v) external {
        v.unpause();
        v.pause();
    }

    /// Swallows a failing inner pause(), so the unpause() persists.
    function unpauseThenTryPause(Veltrio v) external returns (bool ok) {
        v.unpause();
        try v.pause() {
            ok = true;
        } catch {
            ok = false;
        }
    }
}

/// @dev Pure helper to measure the minimum "payments open" time over every 4-day window.
/// Pause intervals are closed-open [s, e), disjoint and ordered; only windows lying
/// fully inside [begin, limit] are examined. The open time is piecewise linear in the
/// window start, so its minimum is attained where a window edge meets an interval edge.
library PauseWindow {
    uint256 internal constant W = 4 days;

    function closedIn(uint256[] memory s, uint256[] memory e, uint256 a) internal pure returns (uint256 total) {
        uint256 b = a + W;
        for (uint256 i; i < s.length; i++) {
            uint256 lo = s[i] > a ? s[i] : a;
            uint256 hi = e[i] < b ? e[i] : b;
            if (hi > lo) total += hi - lo;
        }
    }

    function minOpen(uint256[] memory s, uint256[] memory e, uint256 begin, uint256 limit)
        internal
        pure
        returns (uint256 m)
    {
        m = W;
        for (uint256 i; i < s.length; i++) {
            for (uint256 k; k < 4; k++) {
                uint256 edge = (k % 2 == 0) ? s[i] : e[i];
                uint256 c;
                if (k < 2) {
                    c = edge;
                } else {
                    if (edge < W) continue;
                    c = edge - W;
                }
                if (c < begin || c + W > limit) continue;
                uint256 open = W - closedIn(s, e, c);
                if (open < m) m = open;
            }
        }
    }
}

contract VeltrioTest is Test {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant OWNER = 0x901f10BC9F2Af3785CF29dDB93A2afe68008D7B2;
    string internal constant MOCK = "Veltrio.t.sol:MockUsdc";

    Veltrio internal veltrio;
    MockUsdc internal usdc;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");
    address internal newOwner = makeAddr("newOwner");
    bytes32 internal constant REF = keccak256("invoice-42");

    function setUp() public {
        vm.chainId(5042);
        deployCodeTo(MOCK, USDC);
        usdc = MockUsdc(USDC);
        veltrio = new Veltrio(OWNER);

        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(address(veltrio), 50e6);
    }

    // ------------------------------------------------------------------
    // Deployment
    // ------------------------------------------------------------------

    function test_Deploy_SetsOwnerAndNoPendingOwner() public view {
        assertEq(veltrio.owner(), OWNER);
        assertEq(veltrio.pendingOwner(), address(0));
        assertFalse(veltrio.paused());
    }

    function test_Deploy_RevertsForZeroInitialOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new Veltrio(address(0));
    }

    function test_Deploy_ZeroOwnerCheckedBeforeChainCheck() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new Veltrio(address(0));
    }

    function test_Deploy_SucceedsOnArcMainnetWithSixDecimals() public {
        Veltrio v = new Veltrio(OWNER);
        assertGt(address(v).code.length, 0);
        assertEq(v.owner(), OWNER);
    }

    function test_Constants() public view {
        assertEq(veltrio.USDC(), 0x3600000000000000000000000000000000000000);
        assertEq(veltrio.ARC_MAINNET_CHAIN_ID(), 5042);
        assertEq(uint256(veltrio.USDC_DECIMALS()), 6);
    }

    function test_Deploy_RevertsOnEthereumMainnet() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.WrongChain.selector, uint256(1)));
        new Veltrio(OWNER);
    }

    function test_Deploy_RevertsOnArcTestnet() public {
        vm.chainId(5042002);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.WrongChain.selector, uint256(5042002)));
        new Veltrio(OWNER);
    }

    function test_Deploy_RevertsOnLocalChain() public {
        vm.chainId(31337);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.WrongChain.selector, uint256(31337)));
        new Veltrio(OWNER);
    }

    function testFuzz_Deploy_RevertsOnAnyOtherChain(uint64 chainId) public {
        vm.assume(chainId != 5042 && chainId != 0);
        vm.chainId(chainId);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.WrongChain.selector, uint256(chainId)));
        new Veltrio(OWNER);
    }

    function test_Deploy_RevertsWhenTokenHasNoCode() public {
        vm.etch(USDC, "");
        vm.expectRevert(Veltrio.TokenHasNoCode.selector);
        new Veltrio(OWNER);
    }

    function test_Deploy_RevertsWhenDecimalsIs18() public {
        usdc.setDecimals(18);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidTokenDecimals.selector, uint8(18)));
        new Veltrio(OWNER);
    }

    function test_Deploy_RevertsWhenDecimalsIs0() public {
        usdc.setDecimals(0);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidTokenDecimals.selector, uint8(0)));
        new Veltrio(OWNER);
    }

    function test_Deploy_RevertsWhenDecimalsIs255() public {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(uint256(8)), USDC);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidTokenDecimals.selector, uint8(255)));
        new Veltrio(OWNER);
    }

    function _expectDecimalsFailure(uint256 variant) internal {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(variant), USDC);
        vm.expectRevert(Veltrio.TokenDecimalsCallFailed.selector);
        new Veltrio(OWNER);
    }

    function test_Deploy_RevertsWhenDecimalsCallReverts() public {
        _expectDecimalsFailure(0);
    }

    function test_Deploy_RevertsWhenDecimalsReturnsEmptyData() public {
        _expectDecimalsFailure(1);
    }

    function test_Deploy_RevertsWhenDecimalsReturnsShortData() public {
        _expectDecimalsFailure(2);
    }

    function test_Deploy_RevertsWhenDecimalsReturnsLongData() public {
        _expectDecimalsFailure(5);
    }

    function test_Deploy_RevertsWhenDecimalsAbove255() public {
        _expectDecimalsFailure(3);
    }

    function test_Deploy_RevertsWhenDecimalsIsUint256Max() public {
        _expectDecimalsFailure(4);
    }

    function test_Deploy_RevertsWhenDecimalsMissing() public {
        deployCodeTo("Veltrio.t.sol:MockNoDecimals", USDC);
        vm.expectRevert(Veltrio.TokenDecimalsCallFailed.selector);
        new Veltrio(OWNER);
    }

    function test_Deploy_SucceedsWithMinimalSixDecimalsToken() public {
        deployCodeTo("Veltrio.t.sol:MockDecimalsVariant", abi.encode(uint256(6)), USDC);
        Veltrio v = new Veltrio(OWNER);
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

    function test_Pay_OwnerPaysLikeAnyoneElse() public {
        usdc.mint(OWNER, 10e6);
        vm.prank(OWNER);
        usdc.approve(address(veltrio), 10e6);
        vm.prank(OWNER);
        veltrio.pay(bob, 10e6, REF);
        assertEq(usdc.balanceOf(bob), 10e6);
    }

    function test_Pay_AcceptsTokenReturningNoData() public {
        usdc.setMode(MockUsdc.Mode.NoData);
        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Veltrio.Payment(alice, bob, REF, 4e6);
        vm.prank(alice);
        veltrio.pay(bob, 4e6, REF);
        assertEq(usdc.balanceOf(bob), 4e6);
        assertEq(usdc.balanceOf(address(veltrio)), 0);
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
        vm.expectRevert(MockUsdc.InsufficientAllowance.selector);
        veltrio.pay(bob, 1e6, REF);
    }

    function test_Pay_RevertsWhenAllowanceTooLow() public {
        vm.prank(alice);
        vm.expectRevert(MockUsdc.InsufficientAllowance.selector);
        veltrio.pay(bob, 50e6 + 1, REF);
    }

    function test_Pay_RevertsWhenBalanceTooLow() public {
        vm.prank(alice);
        usdc.approve(address(veltrio), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(MockUsdc.InsufficientBalance.selector);
        veltrio.pay(bob, 100e6 + 1, REF);
    }

    function test_Pay_RevertsWhenTokenReturnsFalse() public {
        usdc.setMode(MockUsdc.Mode.ReturnFalse);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, USDC));
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_Pay_RevertsWhenTokenReturnsOneByte() public {
        usdc.setMode(MockUsdc.Mode.OneByte);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, USDC));
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_Pay_RevertsWhenTokenReturnsTwo() public {
        usdc.setMode(MockUsdc.Mode.TwoValue);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, USDC));
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_Pay_TokenReturningLongDataWithTrueFirstWord() public {
        usdc.setMode(MockUsdc.Mode.LongData);
        vm.prank(alice);
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), 1e6);
    }

    function test_Pay_BubblesTokenRevertReason() public {
        usdc.setMode(MockUsdc.Mode.Revert);
        vm.prank(alice);
        vm.expectRevert(bytes("token revert"));
        veltrio.pay(bob, 1e6, REF);
    }

    function test_Pay_RevertsWhenPayerBlocklisted() public {
        usdc.setBlocked(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.Blocked.selector, alice));
        veltrio.pay(bob, 1e6, REF);
    }

    function test_Pay_RevertsWhenRecipientBlocklisted() public {
        usdc.setBlocked(bob, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.Blocked.selector, bob));
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
    // Pause
    // ------------------------------------------------------------------

    function test_Pause_OwnerPausesAndEmits() public {
        vm.expectEmit(false, false, false, true, address(veltrio));
        emit Pausable.Paused(OWNER);
        vm.prank(OWNER);
        veltrio.pause();
        assertTrue(veltrio.paused());
    }

    function test_Pause_BlocksPay() public {
        vm.prank(OWNER);
        veltrio.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), 0);
        assertEq(usdc.balanceOf(alice), 100e6);
    }

    function test_Pause_PausedCheckedBeforeArgumentValidation() public {
        vm.prank(OWNER);
        veltrio.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        veltrio.pay(address(0), 0, REF);
    }

    function test_Unpause_RestoresPayAndEmits() public {
        vm.prank(OWNER);
        veltrio.pause();

        vm.expectEmit(false, false, false, true, address(veltrio));
        emit Pausable.Unpaused(OWNER);
        vm.prank(OWNER);
        veltrio.unpause();
        assertFalse(veltrio.paused());

        vm.prank(alice);
        veltrio.pay(bob, 2e6, REF);
        assertEq(usdc.balanceOf(bob), 2e6);
    }

    /// A second pause while one is active is rejected. pause() checks _requireNotPaused()
    /// first, so the revert is OZ EnforcedPause (not PauseCooldown).
    function test_Pause_DoublePauseReverts() public {
        vm.startPrank(OWNER);
        veltrio.pause();
        uint256 lock = veltrio.pauseLockedUntil();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        veltrio.pause();
        vm.stopPrank();
        assertTrue(veltrio.paused());
        assertEq(veltrio.pauseLockedUntil(), lock);
    }

    /// unpause() starts the mandatory 1-day unpaused interval from NOW.
    function test_Unpause_SetsCooldownToNowPlusOneDay() public {
        vm.warp(T0);
        vm.prank(OWNER);
        veltrio.pause();
        vm.warp(T0 + 2 hours);
        vm.prank(OWNER);
        veltrio.unpause();
        assertEq(veltrio.pauseLockedUntil(), T0 + 2 hours + 1 days);
    }

    function test_Unpause_WhenNotPausedReverts() public {
        vm.prank(OWNER);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        veltrio.unpause();
    }

    function test_Unpause_DoubleUnpauseReverts() public {
        vm.startPrank(OWNER);
        veltrio.pause();
        veltrio.unpause();
        vm.expectRevert(Pausable.ExpectedPause.selector);
        veltrio.unpause();
        vm.stopPrank();
    }

    function test_Pause_DoesNotBlockRescueOrOwnership() public {
        usdc.mint(address(veltrio), 3e6);
        vm.deal(address(veltrio), 2 ether);
        vm.prank(OWNER);
        veltrio.pause();

        vm.startPrank(OWNER);
        veltrio.rescueToken(USDC, bob, 3e6);
        veltrio.rescueNative(payable(bob), 2 ether);
        veltrio.transferOwnership(newOwner);
        vm.stopPrank();
        assertEq(usdc.balanceOf(bob), 3e6);
        assertEq(bob.balance, 2 ether);

        vm.prank(newOwner);
        veltrio.acceptOwnership();
        assertEq(veltrio.owner(), newOwner);
        assertTrue(veltrio.paused());
    }

    // ------------------------------------------------------------------
    // Auto-expiring pause + cooldown
    // ------------------------------------------------------------------

    uint256 internal constant T0 = 1_000_000;
    uint256 internal constant MAXP = 3 days;
    uint256 internal constant COOL = 1 days;

    function _pauseAt(uint256 ts) internal {
        vm.warp(ts);
        vm.prank(OWNER);
        veltrio.pause();
    }

    function _payOk() internal {
        uint256 before = usdc.balanceOf(bob);
        vm.prank(alice);
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), before + 1e6);
    }

    function _payBlocked() internal {
        uint256 before = usdc.balanceOf(bob);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), before);
    }

    function _pauseReverts(uint256 lock) internal {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.PauseCooldown.selector, lock));
        veltrio.pause();
    }

    function test_PauseExpiry_ConstantsAndInitialState() public view {
        assertEq(veltrio.MAX_PAUSE_DURATION(), 259_200);
        assertEq(veltrio.MAX_PAUSE_DURATION(), 3 days);
        assertEq(veltrio.PAUSE_COOLDOWN(), 86_400);
        assertEq(veltrio.PAUSE_COOLDOWN(), 1 days);
        assertEq(veltrio.pausedAt(), 0);
        assertEq(veltrio.pauseLockedUntil(), 0);
    }

    function test_PauseExpiry_PauseRecordsTimestampAndLock() public {
        _pauseAt(T0);
        assertEq(veltrio.pausedAt(), T0);
        assertEq(veltrio.pauseLockedUntil(), T0 + 4 days);
    }

    function test_PauseExpiry_PayBlockedThenAllowedAtExactBoundary_LostOwner() public {
        _pauseAt(T0);
        // The owner key is never used again from here on.
        vm.warp(T0 + 1);
        _payBlocked();
        vm.warp(T0 + 1 days);
        _payBlocked();
        vm.warp(T0 + MAXP - 1);
        _payBlocked();
        assertTrue(veltrio.paused());

        vm.warp(T0 + MAXP);
        assertFalse(veltrio.paused());
        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Veltrio.Payment(alice, bob, REF, 1e6);
        vm.prank(alice);
        veltrio.pay(bob, 1e6, REF);
        assertEq(usdc.balanceOf(bob), 1e6);

        vm.warp(T0 + MAXP + 1);
        _payOk();
        vm.warp(T0 + 365 days);
        _payOk();
        assertFalse(veltrio.paused());
    }

    function test_PauseExpiry_PausedViewAtKeyTimes() public {
        assertFalse(veltrio.paused());
        _pauseAt(T0);
        assertTrue(veltrio.paused());
        vm.warp(T0 + MAXP - 1);
        assertTrue(veltrio.paused());
        vm.warp(T0 + MAXP);
        assertFalse(veltrio.paused());
        vm.warp(T0 + MAXP + 1);
        assertFalse(veltrio.paused());
        vm.warp(T0 + MAXP + COOL);
        assertFalse(veltrio.paused());
    }

    function test_PauseExpiry_CooldownBlocksRepauseWithExactLockedUntil() public {
        _pauseAt(T0);
        uint256 lock = T0 + MAXP + COOL;
        assertEq(veltrio.pauseLockedUntil(), lock);

        vm.warp(T0 + MAXP); // just expired
        _pauseReverts(lock);
        vm.warp(T0 + MAXP + 1);
        _pauseReverts(lock);
        vm.warp(lock - 1);
        _pauseReverts(lock);

        // State untouched by the failed attempts and payments still flow.
        assertEq(veltrio.pausedAt(), T0);
        assertEq(veltrio.pauseLockedUntil(), lock);
        assertFalse(veltrio.paused());
        _payOk();
    }

    function test_PauseExpiry_RepauseAllowedExactlyAtCooldownEnd() public {
        _pauseAt(T0);
        uint256 lock = T0 + MAXP + COOL;
        vm.warp(lock);

        vm.expectEmit(false, false, false, true, address(veltrio));
        emit Pausable.Paused(OWNER);
        vm.prank(OWNER);
        veltrio.pause();

        assertTrue(veltrio.paused());
        assertEq(veltrio.pausedAt(), lock);
        assertEq(veltrio.pauseLockedUntil(), lock + MAXP + COOL);
        _payBlocked();

        // The new pause also auto-expires after 3 days.
        vm.warp(lock + MAXP - 1);
        _payBlocked();
        vm.warp(lock + MAXP);
        assertFalse(veltrio.paused());
        _payOk();
    }

    function test_PauseExpiry_RepauseWellAfterCooldownWorks() public {
        _pauseAt(T0);
        _pauseAt(T0 + 100 days);
        assertTrue(veltrio.paused());
        assertEq(veltrio.pausedAt(), T0 + 100 days);
        assertEq(veltrio.pauseLockedUntil(), T0 + 100 days + 4 days);
        _payBlocked();
    }

    function _pauseRevertsActive() internal {
        vm.prank(OWNER);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        veltrio.pause();
    }

    function test_PauseExpiry_DoublePauseDuringActivePauseRevertsAtAnyTime() public {
        _pauseAt(T0);
        _pauseRevertsActive();
        vm.warp(T0 + 1);
        _pauseRevertsActive();
        vm.warp(T0 + MAXP - 1);
        _pauseRevertsActive(); // EnforcedPause wins over the cooldown check
        assertEq(veltrio.pausedAt(), T0);
        assertEq(veltrio.pauseLockedUntil(), T0 + 4 days);
        assertTrue(veltrio.paused());
    }

    function test_PauseExpiry_EarlyUnpauseStartsOneDayCooldown() public {
        _pauseAt(T0);
        uint256 t1 = T0 + 1 hours;
        vm.warp(t1);

        vm.expectEmit(false, false, false, true, address(veltrio));
        emit Pausable.Unpaused(OWNER);
        vm.prank(OWNER);
        veltrio.unpause();

        assertFalse(veltrio.paused());
        assertEq(veltrio.pauseLockedUntil(), t1 + COOL);
        assertEq(veltrio.pausedAt(), T0); // history is not rewritten
        _payOk();

        // Immediate re-pause (same timestamp) is rejected, as is anything before t1 + 1 day.
        _pauseReverts(t1 + COOL);
        vm.warp(t1 + 1);
        _pauseReverts(t1 + COOL);
        vm.warp(t1 + COOL - 1);
        _pauseReverts(t1 + COOL);
        _payOk();
        assertFalse(veltrio.paused());
        assertEq(veltrio.pausedAt(), T0);

        // Allowed exactly at unpauseTime + 1 day.
        vm.warp(t1 + COOL);
        vm.prank(OWNER);
        veltrio.pause();
        assertTrue(veltrio.paused());
        assertEq(veltrio.pausedAt(), t1 + COOL);
        assertEq(veltrio.pauseLockedUntil(), t1 + COOL + 4 days);
        _payBlocked();

        // The re-pause expires 3 days after ITS start, not after the first pause.
        vm.warp(t1 + COOL + MAXP - 1);
        _payBlocked();
        vm.warp(t1 + COOL + MAXP);
        _payOk();
    }

    function test_PauseExpiry_EarlyUnpauseOneSecondBeforeExpiry() public {
        _pauseAt(T0);
        vm.warp(T0 + MAXP - 1);
        vm.prank(OWNER);
        veltrio.unpause();
        uint256 lock = T0 + MAXP - 1 + COOL;
        assertEq(veltrio.pauseLockedUntil(), lock);
        _payOk();
        _pauseReverts(lock); // cooldown applies even right before natural expiry
        vm.warp(lock - 1);
        _pauseReverts(lock);
        vm.warp(lock);
        vm.prank(OWNER);
        veltrio.pause();
        assertTrue(veltrio.paused());
    }

    /// Payments stay open for a full day after an early unpause, regardless of owner actions.
    function test_PauseExpiry_UnpauseThenPauseCannotKeepPaymentsClosed() public {
        _pauseAt(T0);
        vm.warp(T0 + 1 days);
        vm.prank(OWNER);
        veltrio.unpause();
        for (uint256 dt; dt < COOL; dt += 1 hours) {
            vm.warp(T0 + 1 days + dt);
            _payOk();
            _pauseReverts(T0 + 1 days + COOL);
        }
    }

    function test_PauseExpiry_UnpauseAfterAutoExpiryReverts() public {
        _pauseAt(T0);
        uint256 lock = T0 + MAXP + COOL;

        vm.warp(T0 + MAXP); // exactly expired
        vm.prank(OWNER);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        veltrio.unpause();

        vm.warp(T0 + MAXP + 1 hours); // inside cooldown
        vm.prank(OWNER);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        veltrio.unpause();

        vm.warp(lock + 30 days); // long after cooldown
        vm.prank(OWNER);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        veltrio.unpause();

        // Failed unpauses must not shorten the cooldown.
        assertEq(veltrio.pauseLockedUntil(), lock);
    }

    function test_PauseExpiry_FailedUnpauseAfterExpiryDoesNotShortenCooldown() public {
        _pauseAt(T0);
        vm.warp(T0 + MAXP + 1);
        vm.prank(OWNER);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        veltrio.unpause();
        _pauseReverts(T0 + MAXP + COOL);
    }

    function test_PauseExpiry_UnpauseBeforeAnyPauseStillReverts() public {
        vm.warp(T0);
        vm.prank(OWNER);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        veltrio.unpause();
        assertEq(veltrio.pauseLockedUntil(), 0);
    }

    function test_PauseExpiry_StrangerCannotPauseOrUnpauseInAnyPhase() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        uint256[4] memory times = [T0, T0 + MAXP - 1, T0 + MAXP, T0 + MAXP + COOL];
        _pauseAt(T0);
        for (uint256 i; i < times.length; i++) {
            vm.warp(times[i]);
            vm.startPrank(stranger);
            vm.expectRevert(err); // auth is checked before cooldown / state checks
            veltrio.pause();
            vm.expectRevert(err);
            veltrio.unpause();
            vm.stopPrank();
        }
        assertEq(veltrio.pausedAt(), T0);
        assertEq(veltrio.pauseLockedUntil(), T0 + 4 days);
    }

    function test_PauseExpiry_StrangerCannotExtendOrReviveExpiredPause() public {
        _pauseAt(T0);
        vm.warp(T0 + MAXP + COOL + 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        veltrio.pause();
        assertFalse(veltrio.paused());
        _payOk();
    }

    function _assertAdminWorksAt(uint256 ts, bool expectPaused) internal {
        vm.warp(ts);
        assertEq(veltrio.paused(), expectPaused);
        usdc.mint(address(veltrio), 3e6);
        vm.deal(address(veltrio), 2 ether);
        address carol = makeAddr("carol");
        vm.startPrank(OWNER);
        veltrio.rescueToken(USDC, carol, 3e6);
        veltrio.rescueNative(payable(carol), 2 ether);
        veltrio.transferOwnership(newOwner);
        vm.stopPrank();
        assertEq(usdc.balanceOf(carol), 3e6);
        assertEq(carol.balance, 2 ether);
        assertEq(veltrio.pendingOwner(), newOwner);
        vm.prank(newOwner);
        veltrio.acceptOwnership();
        assertEq(veltrio.owner(), newOwner);
        assertEq(veltrio.pendingOwner(), address(0));
        // hand back so the helper can be called repeatedly
        vm.prank(newOwner);
        veltrio.transferOwnership(OWNER);
        vm.prank(OWNER);
        veltrio.acceptOwnership();
        assertEq(veltrio.owner(), OWNER);
    }

    function test_PauseExpiry_AdminFunctionsWorkDuringActivePause() public {
        _pauseAt(T0);
        _assertAdminWorksAt(T0 + MAXP - 1, true);
    }

    function test_PauseExpiry_AdminFunctionsWorkAfterExpiry() public {
        _pauseAt(T0);
        _assertAdminWorksAt(T0 + MAXP, false);
    }

    function test_PauseExpiry_AdminFunctionsWorkDuringCooldown() public {
        _pauseAt(T0);
        _assertAdminWorksAt(T0 + MAXP + COOL - 1, false);
        // ownership churn did not alter the cooldown
        _pauseReverts(T0 + MAXP + COOL);
    }

    function test_PauseExpiry_AdminFunctionsWorkAfterCooldown() public {
        _pauseAt(T0);
        _assertAdminWorksAt(T0 + MAXP + COOL, false);
    }

    function test_PauseExpiry_NewOwnerInheritsCooldownAndCanRepauseAfter() public {
        _pauseAt(T0);
        vm.prank(OWNER);
        veltrio.transferOwnership(newOwner);
        vm.prank(newOwner);
        veltrio.acceptOwnership();

        vm.warp(T0 + MAXP + 1);
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.PauseCooldown.selector, T0 + MAXP + COOL));
        veltrio.pause();

        vm.warp(T0 + MAXP + COOL);
        vm.prank(newOwner);
        veltrio.pause();
        assertTrue(veltrio.paused());
    }

    function test_PauseExpiry_PayStillValidatesArgsAfterExpiry() public {
        _pauseAt(T0);
        vm.warp(T0 + MAXP);
        vm.prank(alice);
        vm.expectRevert(Veltrio.ZeroAmount.selector);
        veltrio.pay(bob, 0, REF);
    }

    function test_PauseExpiry_UserFundsAndAllowanceUntouchedAcrossLifecycle() public {
        _pauseAt(T0);
        vm.warp(T0 + MAXP + COOL);
        vm.prank(OWNER);
        veltrio.pause();
        vm.warp(T0 + 2 * (MAXP + COOL));
        _assertAliceUntouched();
    }

    // Fuzz: pay availability depends only on elapsed time since the pause.
    function testFuzz_PauseExpiry_PayAvailabilityByTime(uint256 dt) public {
        dt = bound(dt, 0, 400 days);
        _pauseAt(T0);
        vm.warp(T0 + dt);
        assertEq(veltrio.paused(), dt < MAXP);
        if (dt < MAXP) {
            _payBlocked();
        } else {
            _payOk();
        }
    }

    // Fuzz: re-pause is possible iff the cooldown (pause start + 4 days) has elapsed.
    function testFuzz_PauseExpiry_RepauseByTime(uint256 dt) public {
        dt = bound(dt, 0, 30 days);
        _pauseAt(T0);
        vm.warp(T0 + dt);
        if (dt < MAXP) {
            _pauseRevertsActive(); // still actively paused
            assertEq(veltrio.pausedAt(), T0);
        } else if (dt < MAXP + COOL) {
            _pauseReverts(T0 + MAXP + COOL);
            assertEq(veltrio.pausedAt(), T0);
        } else {
            vm.prank(OWNER);
            veltrio.pause();
            assertEq(veltrio.pausedAt(), T0 + dt);
            assertTrue(veltrio.paused());
        }
    }

    // Fuzz: a voluntary resume at any time before expiry forces a 1-day unpaused interval.
    function testFuzz_PauseExpiry_EarlyUnpauseThenRepauseOnlyAfterOneDay(uint256 dt, uint256 wait) public {
        dt = bound(dt, 0, MAXP - 1);
        wait = bound(wait, 0, 3 days);
        _pauseAt(T0);
        vm.warp(T0 + dt);
        vm.prank(OWNER);
        veltrio.unpause();
        uint256 lock = T0 + dt + COOL;
        assertEq(veltrio.pauseLockedUntil(), lock);
        assertFalse(veltrio.paused());

        _pauseReverts(lock); // immediate re-pause rejected
        vm.warp(T0 + dt + wait);
        if (wait < COOL) {
            _pauseReverts(lock);
            _payOk();
        } else {
            vm.prank(OWNER);
            veltrio.pause();
            assertTrue(veltrio.paused());
            assertEq(veltrio.pauseLockedUntil(), T0 + dt + wait + 4 days);
        }
    }

    // Fuzz: unpause is possible iff the pause has not yet expired.
    function testFuzz_PauseExpiry_UnpauseByTime(uint256 dt) public {
        dt = bound(dt, 0, 400 days);
        _pauseAt(T0);
        vm.warp(T0 + dt);
        vm.prank(OWNER);
        if (dt >= MAXP) {
            vm.expectRevert(Pausable.ExpectedPause.selector);
            veltrio.unpause();
        } else {
            veltrio.unpause();
            assertFalse(veltrio.paused());
        }
    }

    // Fuzz: arbitrary pause timestamps keep lock = start + 4 days and expiry = start + 3 days.
    function testFuzz_PauseExpiry_StartTimeArithmetic(uint64 start) public {
        uint256 s = bound(start, 1, type(uint64).max);
        _pauseAt(s);
        assertEq(veltrio.pausedAt(), s);
        assertEq(veltrio.pauseLockedUntil(), s + 4 days);
        vm.warp(s + MAXP - 1);
        assertTrue(veltrio.paused());
        vm.warp(s + MAXP);
        assertFalse(veltrio.paused());
    }

    // ------------------------------------------------------------------
    // Atomic unpause-then-pause through a contract owner
    // ------------------------------------------------------------------

    function _cyclerSetup() internal returns (OwnerCycler c, Veltrio v) {
        c = new OwnerCycler();
        v = new Veltrio(address(c));
        vm.prank(alice);
        usdc.approve(address(v), 50e6);
    }

    function testFuzz_Atomic_UnpauseThenPauseInOneTxIsRejected(uint256 dt) public {
        dt = bound(dt, 0, MAXP - 1);
        (OwnerCycler c, Veltrio v) = _cyclerSetup();
        vm.warp(T0);
        c.pause(v);
        vm.warp(T0 + dt);

        vm.expectRevert(abi.encodeWithSelector(Veltrio.PauseCooldown.selector, T0 + dt + COOL));
        c.unpauseThenPause(v);

        // The whole transaction reverted: the original pause is untouched and still expires on time.
        assertTrue(v.paused());
        assertEq(v.pausedAt(), T0);
        assertEq(v.pauseLockedUntil(), T0 + 4 days);
        vm.warp(T0 + MAXP);
        assertFalse(v.paused());
    }

    function test_Atomic_UnpauseThenPauseRejectedEvenAtTheSameInstantAsPause() public {
        (OwnerCycler c, Veltrio v) = _cyclerSetup();
        vm.warp(T0);
        c.pause(v);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.PauseCooldown.selector, T0 + COOL));
        c.unpauseThenPause(v);
        assertTrue(v.paused());
    }

    function test_Atomic_SwallowedPauseFailureLeavesPaymentsOpen() public {
        (OwnerCycler c, Veltrio v) = _cyclerSetup();
        vm.warp(T0);
        c.pause(v);
        vm.warp(T0 + 1 hours);

        bool ok = c.unpauseThenTryPause(v);
        assertFalse(ok, "in-tx re-pause must fail");
        assertFalse(v.paused());
        assertEq(v.pauseLockedUntil(), T0 + 1 hours + COOL);
        assertEq(v.pausedAt(), T0);

        vm.prank(alice);
        v.pay(bob, 1e6, REF); // payments are open
        assertEq(usdc.balanceOf(bob), 1e6);

        // Still cannot pause until the full day has passed; allowed exactly at the end.
        vm.warp(T0 + 1 hours + COOL - 1);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.PauseCooldown.selector, T0 + 1 hours + COOL));
        c.pause(v);
        vm.warp(T0 + 1 hours + COOL);
        c.pause(v);
        assertTrue(v.paused());
    }

    // ------------------------------------------------------------------
    // Fuzz: payments open >= 1 day in every 4-day window
    // ------------------------------------------------------------------

    uint256[] internal wS; // recorded pause starts
    uint256[] internal wE; // recorded pause effective ends

    function testFuzz_PauseWindow_AnyOwnerSequenceKeepsPaymentsOpenOneDayInFour(uint256[] memory steps) public {
        uint256 begin = block.timestamp;
        uint256 n = steps.length > 40 ? 40 : steps.length;
        for (uint256 i; i < n; i++) {
            vm.warp(block.timestamp + ((steps[i] >> 8) % (5 days + 1)));
            _windowStep(steps[i] % 3);
            // paused() must agree with the independently recorded intervals.
            bool expectPaused = wS.length > 0 && block.timestamp >= wS[wS.length - 1]
                && block.timestamp < wE[wE.length - 1];
            assertEq(veltrio.paused(), expectPaused);
        }
        uint256[] memory s = wS;
        uint256[] memory e = wE;
        assertGe(PauseWindow.minOpen(s, e, begin, veltrio.pauseLockedUntil()), 1 days);
    }

    /// Self-check of the window oracle: it must flag the old unpause-then-pause behaviour.
    function test_PauseWindow_OracleDetectsBackToBackPauses() public pure {
        uint256[] memory s = new uint256[](2);
        uint256[] memory e = new uint256[](2);
        s[0] = 10 days;
        e[0] = 10 days + 1 hours; // early unpause...
        s[1] = e[0]; // ...immediately re-paused (old behaviour)
        e[1] = s[1] + 3 days;
        assertLt(PauseWindow.minOpen(s, e, 5 days, 30 days), 1 days);
        // Honoring the 1-day cooldown restores the guarantee.
        s[1] = e[0] + 1 days;
        e[1] = s[1] + 3 days;
        assertGe(PauseWindow.minOpen(s, e, 5 days, 30 days), 1 days);
    }

    function _windowStep(uint256 op) internal {
        bool wasPaused = veltrio.paused();
        uint256 lock = veltrio.pauseLockedUntil();
        if (op == 0) {
            vm.prank(OWNER);
            if (wasPaused) {
                vm.expectRevert(Pausable.EnforcedPause.selector);
            } else if (block.timestamp < lock) {
                vm.expectRevert(abi.encodeWithSelector(Veltrio.PauseCooldown.selector, lock));
            }
            veltrio.pause();
            if (!wasPaused && block.timestamp >= lock) {
                wS.push(block.timestamp);
                wE.push(block.timestamp + MAXP);
            }
        } else if (op == 1) {
            vm.prank(OWNER);
            if (!wasPaused) vm.expectRevert(Pausable.ExpectedPause.selector);
            veltrio.unpause();
            if (wasPaused) {
                wE[wE.length - 1] = block.timestamp;
                assertEq(veltrio.pauseLockedUntil(), block.timestamp + COOL);
            }
        } else if (wasPaused) {
            _payBlocked();
        } else {
            _payOk();
        }
    }

    // ------------------------------------------------------------------
    // Fuzz: pay
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
        vm.expectRevert(MockUsdc.InsufficientAllowance.selector);
        veltrio.pay(bob, amount, ref);
    }

    function testFuzz_Pay_AnyValidRecipient(address to, uint256 amount, bytes32 ref) public {
        vm.assume(to != address(0) && to != address(veltrio) && to != USDC && to != alice);
        amount = bound(amount, 1, 50e6);
        vm.prank(alice);
        veltrio.pay(to, amount, ref);
        assertEq(usdc.balanceOf(to), amount);
        assertEq(usdc.balanceOf(address(veltrio)), 0);
    }

    function testFuzz_Pay_AnyPayer(address payer, uint256 funds, uint256 amount, bytes32 ref) public {
        vm.assume(payer != address(0) && payer != address(veltrio) && payer != USDC);
        vm.assume(payer != bob && payer != alice && payer != address(vm));
        funds = bound(funds, 1, 1_000_000e6);
        amount = bound(amount, 1, funds);
        usdc.mint(payer, funds);
        vm.prank(payer);
        usdc.approve(address(veltrio), amount);

        vm.expectEmit(true, true, true, true, address(veltrio));
        emit Veltrio.Payment(payer, bob, ref, amount);
        vm.prank(payer);
        veltrio.pay(bob, amount, ref);

        assertEq(usdc.balanceOf(payer), funds - amount);
        assertEq(usdc.balanceOf(bob), amount);
        assertEq(usdc.allowance(payer, address(veltrio)), 0);
        assertEq(usdc.balanceOf(address(veltrio)), 0);
    }

    // ------------------------------------------------------------------
    // Access control
    // ------------------------------------------------------------------

    function _unauthorized(address who) internal {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
    }

    function test_Access_StrangerCannotPause() public {
        vm.prank(stranger);
        _unauthorized(stranger);
        veltrio.pause();
        assertFalse(veltrio.paused());
    }

    function test_Access_StrangerCannotUnpause() public {
        vm.prank(OWNER);
        veltrio.pause();
        vm.prank(stranger);
        _unauthorized(stranger);
        veltrio.unpause();
        assertTrue(veltrio.paused());
    }

    function test_Access_StrangerCannotRescueToken() public {
        usdc.mint(address(veltrio), 1e6);
        vm.prank(stranger);
        _unauthorized(stranger);
        veltrio.rescueToken(USDC, stranger, 1e6);
        assertEq(usdc.balanceOf(address(veltrio)), 1e6);
    }

    function test_Access_StrangerCannotRescueNative() public {
        vm.deal(address(veltrio), 1 ether);
        vm.prank(stranger);
        _unauthorized(stranger);
        veltrio.rescueNative(payable(stranger), 1 ether);
        assertEq(address(veltrio).balance, 1 ether);
    }

    function test_Access_StrangerCannotTransferOwnership() public {
        vm.prank(stranger);
        _unauthorized(stranger);
        veltrio.transferOwnership(stranger);
        assertEq(veltrio.owner(), OWNER);
        assertEq(veltrio.pendingOwner(), address(0));
    }

    function test_Access_AuthCheckedBeforeArgumentValidation() public {
        vm.prank(stranger);
        _unauthorized(stranger);
        veltrio.rescueToken(address(0), address(0), 0);
    }

    function testFuzz_Access_NonOwnerCannotCallAdminFunctions(
        address caller,
        address to,
        uint256 amount
    ) public {
        vm.assume(caller != OWNER && caller != address(vm));
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller);

        vm.startPrank(caller);
        vm.expectRevert(err);
        veltrio.pause();
        vm.expectRevert(err);
        veltrio.unpause();
        vm.expectRevert(err);
        veltrio.rescueToken(USDC, to, amount);
        vm.expectRevert(err);
        veltrio.rescueNative(payable(to), amount);
        vm.expectRevert(err);
        veltrio.transferOwnership(to);
        vm.stopPrank();

        assertEq(veltrio.owner(), OWNER);
        assertEq(veltrio.pendingOwner(), address(0));
        assertFalse(veltrio.paused());
    }

    // ------------------------------------------------------------------
    // Two-step ownership
    // ------------------------------------------------------------------

    function test_Ownership_TransferStartsPendingAndKeepsOldOwner() public {
        vm.expectEmit(true, true, false, false, address(veltrio));
        emit Ownable2Step.OwnershipTransferStarted(OWNER, newOwner);
        vm.prank(OWNER);
        veltrio.transferOwnership(newOwner);

        assertEq(veltrio.owner(), OWNER);
        assertEq(veltrio.pendingOwner(), newOwner);

        // Old owner keeps full powers while pending.
        vm.prank(OWNER);
        veltrio.pause();
        assertTrue(veltrio.paused());
        // Pending owner has no powers yet.
        vm.prank(newOwner);
        _unauthorized(newOwner);
        veltrio.unpause();
    }

    function test_Ownership_OnlyPendingOwnerCanAccept() public {
        vm.prank(OWNER);
        veltrio.transferOwnership(newOwner);

        vm.prank(stranger);
        _unauthorized(stranger);
        veltrio.acceptOwnership();

        vm.prank(OWNER);
        _unauthorized(OWNER);
        veltrio.acceptOwnership();

        assertEq(veltrio.owner(), OWNER);
        assertEq(veltrio.pendingOwner(), newOwner);
    }

    function test_Ownership_AcceptWithoutPendingReverts() public {
        vm.prank(stranger);
        _unauthorized(stranger);
        veltrio.acceptOwnership();
    }

    function test_Ownership_AcceptTransfersPowers() public {
        vm.prank(OWNER);
        veltrio.transferOwnership(newOwner);

        vm.expectEmit(true, true, false, false, address(veltrio));
        emit Ownable.OwnershipTransferred(OWNER, newOwner);
        vm.prank(newOwner);
        veltrio.acceptOwnership();

        assertEq(veltrio.owner(), newOwner);
        assertEq(veltrio.pendingOwner(), address(0));

        // New owner gains powers.
        vm.startPrank(newOwner);
        veltrio.pause();
        veltrio.unpause();
        vm.stopPrank();

        // Old owner loses them.
        vm.startPrank(OWNER);
        _unauthorized(OWNER);
        veltrio.pause();
        _unauthorized(OWNER);
        veltrio.rescueToken(USDC, bob, 1);
        _unauthorized(OWNER);
        veltrio.rescueNative(payable(bob), 1);
        _unauthorized(OWNER);
        veltrio.transferOwnership(OWNER);
        vm.stopPrank();
    }

    function test_Ownership_NewOwnerCanRescue() public {
        usdc.mint(address(veltrio), 4e6);
        vm.prank(OWNER);
        veltrio.transferOwnership(newOwner);
        vm.prank(newOwner);
        veltrio.acceptOwnership();
        vm.prank(newOwner);
        veltrio.rescueToken(USDC, bob, 4e6);
        assertEq(usdc.balanceOf(bob), 4e6);
    }

    function test_Ownership_CancelByTransferringToAnotherAddress() public {
        vm.startPrank(OWNER);
        veltrio.transferOwnership(newOwner);
        veltrio.transferOwnership(bob);
        vm.stopPrank();
        assertEq(veltrio.pendingOwner(), bob);

        vm.prank(newOwner);
        _unauthorized(newOwner);
        veltrio.acceptOwnership();

        vm.prank(bob);
        veltrio.acceptOwnership();
        assertEq(veltrio.owner(), bob);
    }

    function test_Ownership_CancelByTransferringToZero() public {
        vm.startPrank(OWNER);
        veltrio.transferOwnership(newOwner);
        veltrio.transferOwnership(address(0));
        vm.stopPrank();
        assertEq(veltrio.pendingOwner(), address(0));
        assertEq(veltrio.owner(), OWNER);

        vm.prank(newOwner);
        _unauthorized(newOwner);
        veltrio.acceptOwnership();
    }

    function test_Ownership_PendingOwnerClearedAfterAcceptCannotReaccept() public {
        vm.prank(OWNER);
        veltrio.transferOwnership(newOwner);
        vm.prank(newOwner);
        veltrio.acceptOwnership();
        vm.prank(newOwner);
        _unauthorized(newOwner); // pendingOwner is now zero, caller != pending
        veltrio.acceptOwnership();
        assertEq(veltrio.owner(), newOwner);
    }

    // ------------------------------------------------------------------
    // renounceOwnership disabled
    // ------------------------------------------------------------------

    function test_Renounce_RevertsForOwner() public {
        vm.prank(OWNER);
        vm.expectRevert(Veltrio.RenounceDisabled.selector);
        veltrio.renounceOwnership();
        assertEq(veltrio.owner(), OWNER);
    }

    function test_Renounce_RevertsForStranger() public {
        vm.prank(stranger);
        vm.expectRevert(Veltrio.RenounceDisabled.selector);
        veltrio.renounceOwnership();
        assertEq(veltrio.owner(), OWNER);
    }

    function test_Renounce_RevertsForPendingOwnerAndNewOwner() public {
        vm.prank(OWNER);
        veltrio.transferOwnership(newOwner);
        vm.prank(newOwner);
        vm.expectRevert(Veltrio.RenounceDisabled.selector);
        veltrio.renounceOwnership();

        vm.prank(newOwner);
        veltrio.acceptOwnership();
        vm.prank(newOwner);
        vm.expectRevert(Veltrio.RenounceDisabled.selector);
        veltrio.renounceOwnership();
        assertEq(veltrio.owner(), newOwner);
    }

    function testFuzz_Renounce_AlwaysReverts(address caller) public {
        vm.assume(caller != address(vm));
        vm.prank(caller);
        vm.expectRevert(Veltrio.RenounceDisabled.selector);
        veltrio.renounceOwnership();
        assertEq(veltrio.owner(), OWNER);
    }

    // ------------------------------------------------------------------
    // rescueToken
    // ------------------------------------------------------------------

    function test_RescueToken_MovesStrayUsdcAndEmits() public {
        usdc.mint(address(veltrio), 8e6);
        vm.expectEmit(true, true, false, true, address(veltrio));
        emit Veltrio.TokenRescued(USDC, bob, 5e6);
        vm.prank(OWNER);
        veltrio.rescueToken(USDC, bob, 5e6);
        assertEq(usdc.balanceOf(bob), 5e6);
        assertEq(usdc.balanceOf(address(veltrio)), 3e6);
    }

    function test_RescueToken_MovesStrayOtherToken() public {
        MockUsdc other = new MockUsdc();
        other.mint(address(veltrio), 123);
        vm.expectEmit(true, true, false, true, address(veltrio));
        emit Veltrio.TokenRescued(address(other), bob, 123);
        vm.prank(OWNER);
        veltrio.rescueToken(address(other), bob, 123);
        assertEq(other.balanceOf(bob), 123);
        assertEq(other.balanceOf(address(veltrio)), 0);
    }

    function test_RescueToken_AcceptsTokenReturningNoData() public {
        usdc.setMode(MockUsdc.Mode.NoData);
        usdc.mint(address(veltrio), 2e6);
        vm.prank(OWNER);
        veltrio.rescueToken(USDC, bob, 2e6);
        assertEq(usdc.balanceOf(bob), 2e6);
    }

    function test_RescueToken_RevertsForZeroRecipient() public {
        usdc.mint(address(veltrio), 1e6);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidRecipient.selector, address(0)));
        veltrio.rescueToken(USDC, address(0), 1e6);
    }

    function test_RescueToken_RevertsForSelfRecipient() public {
        usdc.mint(address(veltrio), 1e6);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidRecipient.selector, address(veltrio)));
        veltrio.rescueToken(USDC, address(veltrio), 1e6);
    }

    function test_RescueToken_RevertsForZeroAmount() public {
        usdc.mint(address(veltrio), 1e6);
        vm.prank(OWNER);
        vm.expectRevert(Veltrio.ZeroAmount.selector);
        veltrio.rescueToken(USDC, bob, 0);
    }

    function test_RescueToken_RevertsOnInsufficientBalance() public {
        usdc.mint(address(veltrio), 1e6);
        vm.prank(OWNER);
        vm.expectRevert(MockUsdc.InsufficientBalance.selector);
        veltrio.rescueToken(USDC, bob, 1e6 + 1);
        assertEq(usdc.balanceOf(address(veltrio)), 1e6);
    }

    function test_RescueToken_RevertsWhenTokenReturnsFalse() public {
        usdc.mint(address(veltrio), 1e6);
        usdc.setMode(MockUsdc.Mode.ReturnFalse);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, USDC));
        veltrio.rescueToken(USDC, bob, 1e6);
    }

    function test_RescueToken_BubblesTokenRevert() public {
        usdc.setMode(MockUsdc.Mode.Revert);
        vm.prank(OWNER);
        vm.expectRevert(bytes("token revert"));
        veltrio.rescueToken(USDC, bob, 1e6);
    }

    function test_RescueToken_RevertsForNonContractToken() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, stranger));
        veltrio.rescueToken(stranger, bob, 1);
    }

    function test_RescueToken_RevertsForZeroAddressToken() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(0)));
        veltrio.rescueToken(address(0), bob, 1);
    }

    // ------------------------------------------------------------------
    // rescueNative
    // ------------------------------------------------------------------

    function test_RescueNative_MovesBalanceAndEmits() public {
        vm.deal(address(veltrio), 5 ether);
        vm.expectEmit(true, false, false, true, address(veltrio));
        emit Veltrio.NativeRescued(bob, 2 ether);
        vm.prank(OWNER);
        veltrio.rescueNative(payable(bob), 2 ether);
        assertEq(bob.balance, 2 ether);
        assertEq(address(veltrio).balance, 3 ether);
    }

    function test_RescueNative_CanSweepEntireBalance() public {
        vm.deal(address(veltrio), 7);
        vm.prank(OWNER);
        veltrio.rescueNative(payable(bob), 7);
        assertEq(bob.balance, 7);
        assertEq(address(veltrio).balance, 0);
    }

    function test_RescueNative_RevertsForZeroRecipient() public {
        vm.deal(address(veltrio), 1 ether);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidRecipient.selector, address(0)));
        veltrio.rescueNative(payable(address(0)), 1);
    }

    function test_RescueNative_RevertsForSelfRecipient() public {
        vm.deal(address(veltrio), 1 ether);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InvalidRecipient.selector, address(veltrio)));
        veltrio.rescueNative(payable(address(veltrio)), 1);
    }

    function test_RescueNative_RevertsForZeroAmount() public {
        vm.deal(address(veltrio), 1 ether);
        vm.prank(OWNER);
        vm.expectRevert(Veltrio.ZeroAmount.selector);
        veltrio.rescueNative(payable(bob), 0);
    }

    function test_RescueNative_RevertsAboveBalance() public {
        vm.deal(address(veltrio), 1 ether);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(Veltrio.InsufficientNativeBalance.selector, 1 ether, 1 ether + 1)
        );
        veltrio.rescueNative(payable(bob), 1 ether + 1);
    }

    function test_RescueNative_RevertsWhenNothingToRescue() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Veltrio.InsufficientNativeBalance.selector, 0, 1));
        veltrio.rescueNative(payable(bob), 1);
    }

    function test_RescueNative_RevertsWhenRecipientRejects() public {
        RejectNative rejecter = new RejectNative();
        vm.deal(address(veltrio), 1 ether);
        vm.prank(OWNER);
        vm.expectRevert(Veltrio.NativeTransferFailed.selector);
        veltrio.rescueNative(payable(address(rejecter)), 1 ether);
        assertEq(address(veltrio).balance, 1 ether);
    }

    function testFuzz_RescueNative(uint256 funded, uint256 amount) public {
        funded = bound(funded, 1, 1_000_000 ether);
        amount = bound(amount, 1, funded);
        vm.deal(address(veltrio), funded);
        vm.prank(OWNER);
        veltrio.rescueNative(payable(bob), amount);
        assertEq(bob.balance, amount);
        assertEq(address(veltrio).balance, funded - amount);
    }

    // ------------------------------------------------------------------
    // Critical security: owner cannot touch user funds or allowances
    // ------------------------------------------------------------------

    function _callAsOwner(bytes memory data) internal returns (bool ok) {
        vm.prank(OWNER);
        (ok,) = address(veltrio).call(data);
    }

    function _assertAliceUntouched() internal view {
        assertEq(usdc.balanceOf(alice), 100e6, "alice balance changed");
        assertEq(usdc.allowance(alice, address(veltrio)), 50e6, "alice allowance changed");
    }

    function test_Security_OwnerCannotMoveUserFundsOrSpendAllowance() public {
        // Every owner function, with the user as every possible argument.
        _callAsOwner(abi.encodeCall(Veltrio.pause, ()));
        _callAsOwner(abi.encodeCall(Veltrio.unpause, ()));
        _callAsOwner(abi.encodeCall(Veltrio.rescueToken, (USDC, OWNER, 100e6)));
        _callAsOwner(abi.encodeCall(Veltrio.rescueToken, (USDC, OWNER, 1)));
        _callAsOwner(abi.encodeCall(Veltrio.rescueToken, (USDC, alice, 1)));
        _callAsOwner(abi.encodeCall(Veltrio.rescueNative, (payable(OWNER), 1)));
        _callAsOwner(abi.encodeCall(Ownable2Step.transferOwnership, (alice)));
        _callAsOwner(abi.encodeWithSignature("renounceOwnership()"));
        // Owner tries to pay on behalf of alice: pay always pulls from msg.sender (the owner).
        _callAsOwner(abi.encodeCall(Veltrio.pay, (OWNER, 50e6, REF)));
        // Non-existent "pull" style functions and a raw token call routed via the helper.
        _callAsOwner(abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, OWNER, 50e6));
        _callAsOwner(abi.encodeWithSignature("sweep(address,address)", USDC, OWNER));
        _callAsOwner(abi.encodeWithSignature("execute(address,bytes)", USDC, ""));

        _assertAliceUntouched();
        assertEq(usdc.balanceOf(OWNER), 0);
    }

    function test_Security_OwnerRescueOnlyTakesStrayBalanceNotUserFunds() public {
        usdc.mint(address(veltrio), 5e6); // stray funds
        vm.startPrank(OWNER);
        veltrio.rescueToken(USDC, OWNER, 5e6);
        // Anything beyond the stray balance cannot be pulled from alice.
        vm.expectRevert(MockUsdc.InsufficientBalance.selector);
        veltrio.rescueToken(USDC, OWNER, 1);
        vm.stopPrank();

        assertEq(usdc.balanceOf(OWNER), 5e6);
        _assertAliceUntouched();
    }

    function test_Security_NewOwnerAlsoCannotTouchUserFunds() public {
        vm.prank(OWNER);
        veltrio.transferOwnership(newOwner);
        vm.prank(newOwner);
        veltrio.acceptOwnership();

        vm.startPrank(newOwner);
        (bool ok,) = address(veltrio).call(abi.encodeCall(Veltrio.rescueToken, (USDC, newOwner, 1)));
        assertFalse(ok);
        vm.stopPrank();
        _assertAliceUntouched();
    }

    function test_Security_NoTokenBalanceHeldAfterPay() public {
        vm.prank(alice);
        veltrio.pay(bob, 10e6, REF);
        assertEq(usdc.balanceOf(address(veltrio)), 0);
        assertEq(address(veltrio).balance, 0);

        // Also with a no-return-data token.
        usdc.setMode(MockUsdc.Mode.NoData);
        vm.prank(alice);
        veltrio.pay(bob, 10e6, REF);
        assertEq(usdc.balanceOf(address(veltrio)), 0);
    }

    function test_Security_PauseDoesNotAffectUserFundsOrAllowance() public {
        vm.prank(OWNER);
        veltrio.pause();
        _assertAliceUntouched();
    }
}

/// @dev Drives random pay / pause / unpause / ownership sequences for the invariant suite.
contract VeltrioHandler is Test {
    Veltrio public immutable veltrio;
    address public immutable owner;
    address public immutable payer;
    address public immutable payee;
    MockUsdc public immutable usdc;
    uint256 public ghostPaid;

    constructor(Veltrio v, MockUsdc u, address _owner, address _payer, address _payee) {
        veltrio = v;
        usdc = u;
        owner = _owner;
        payer = _payer;
        payee = _payee;
    }

    // Ghost counters: each must stay zero for the invariants to hold.
    uint256 public ghostPaidWhilePaused; // pay succeeded although paused() was true
    uint256 public ghostBlockedWhileLive; // pay reverted although paused() was false
    uint256 public ghostBadPauseAccepted; // pause succeeded inside the cooldown
    uint256 public ghostGoodPauseRejected; // pause reverted outside the cooldown
    uint256 public ghostBadUnpauseAccepted; // unpause succeeded while paused() was false
    uint256 public ghostGoodUnpauseRejected; // unpause reverted while paused() was true
    // Coverage ghosts (not invariants).
    uint256 public ghostPauses;
    uint256 public ghostBlockedPays;

    function pay(uint256 amount, bytes32 ref) external {
        amount = bound(amount, 1, 10e6);
        usdc.mint(payer, amount);
        bool wasPaused = veltrio.paused();
        vm.startPrank(payer);
        usdc.approve(address(veltrio), amount);
        try veltrio.pay(payee, amount, ref) {
            ghostPaid += amount;
            if (wasPaused) ghostPaidWhilePaused++;
        } catch {
            if (!wasPaused) ghostBlockedWhileLive++;
            else ghostBlockedPays++;
        }
        vm.stopPrank();
    }

    // Recorded pause intervals [start, end): end is the scheduled expiry, shortened on early unpause.
    uint256[] internal starts;
    uint256[] internal ends;
    uint256 public immutable begin = block.timestamp;
    uint256 public ghostWrongPauseError; // pause reverted with an unexpected error
    uint256 public ghostGapViolations; // a pause started < 1 day after the previous one ended
    uint256 public ghostBadUnpauseLock; // unpause did not set lock to now + 1 day

    function intervals() external view returns (uint256[] memory, uint256[] memory) {
        return (starts, ends);
    }

    function pause() external {
        bool wasPaused = veltrio.paused();
        uint256 lock = veltrio.pauseLockedUntil();
        // Rule: rejected while actively paused (EnforcedPause) or inside the cooldown (PauseCooldown).
        bool shouldReject = wasPaused || block.timestamp < lock;
        vm.prank(owner);
        try veltrio.pause() {
            ghostPauses++;
            if (shouldReject) ghostBadPauseAccepted++;
            if (ends.length > 0 && block.timestamp < ends[ends.length - 1] + 1 days) ghostGapViolations++;
            starts.push(block.timestamp);
            ends.push(block.timestamp + 3 days);
        } catch (bytes memory err) {
            if (!shouldReject) {
                ghostGoodPauseRejected++;
            } else {
                bytes memory expected = wasPaused
                    ? abi.encodeWithSelector(Pausable.EnforcedPause.selector)
                    : abi.encodeWithSelector(Veltrio.PauseCooldown.selector, lock);
                if (keccak256(err) != keccak256(expected)) ghostWrongPauseError++;
            }
        }
    }

    function unpause() external {
        bool wasPaused = veltrio.paused();
        vm.prank(owner);
        try veltrio.unpause() {
            if (!wasPaused) {
                ghostBadUnpauseAccepted++;
            } else {
                ends[ends.length - 1] = block.timestamp;
                if (veltrio.pauseLockedUntil() != block.timestamp + 1 days) ghostBadUnpauseLock++;
            }
        } catch {
            if (wasPaused) ghostGoodUnpauseRejected++;
        }
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 0, 5 days);
        vm.warp(block.timestamp + secs);
    }
}

contract VeltrioInvariantTest is Test {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant OWNER = 0x901f10BC9F2Af3785CF29dDB93A2afe68008D7B2;

    Veltrio internal veltrio;
    MockUsdc internal usdc;
    VeltrioHandler internal handler;

    function setUp() public {
        vm.chainId(5042);
        deployCodeTo("Veltrio.t.sol:MockUsdc", USDC);
        usdc = MockUsdc(USDC);
        veltrio = new Veltrio(OWNER);
        handler = new VeltrioHandler(veltrio, usdc, OWNER, makeAddr("payer"), makeAddr("payee"));
        targetContract(address(handler));
    }

    /// Conservation: the helper never custodies tokens; everything paid reached the payee.
    function invariant_HelperNeverHoldsTokens() public view {
        assertEq(usdc.balanceOf(address(veltrio)), 0);
    }

    function invariant_PayeeReceivedExactlyWhatWasPaid() public view {
        assertEq(usdc.balanceOf(handler.payee()), handler.ghostPaid());
    }

    function invariant_OwnerNeverChanges() public view {
        assertEq(veltrio.owner(), OWNER);
    }

    /// A pause can never be observed once 3 days have passed since it started.
    function invariant_PauseNeverOutlastsMaxDuration() public view {
        if (veltrio.paused()) {
            assertLt(block.timestamp, veltrio.pausedAt() + 3 days);
        }
    }

    /// The lock is never further than pausedAt + 4 days (3 days pause + 1 day cooldown).
    function invariant_LockNeverExceedsPausePlusCooldown() public view {
        assertLe(veltrio.pauseLockedUntil(), veltrio.pausedAt() + 4 days);
    }

    function invariant_PayAvailabilityMatchesPausedView() public view {
        assertEq(handler.ghostPaidWhilePaused(), 0);
        assertEq(handler.ghostBlockedWhileLive(), 0);
    }

    /// Pause is rejected iff actively paused (EnforcedPause) or inside the cooldown
    /// (PauseCooldown(lockedUntil)); nothing else blocks it.
    function invariant_CooldownIsEnforcedExactly() public view {
        assertEq(handler.ghostBadPauseAccepted(), 0);
        assertEq(handler.ghostGoodPauseRejected(), 0);
        assertEq(handler.ghostWrongPauseError(), 0);
    }

    /// Every pause starts at least 1 day after the previous one ended (expiry OR early unpause),
    /// and every early unpause sets the lock to exactly now + 1 day.
    function invariant_EveryPauseFollowsAtLeastOneOpenDay() public view {
        assertEq(handler.ghostGapViolations(), 0);
        assertEq(handler.ghostBadUnpauseLock(), 0);
    }

    /// For ANY owner pause/unpause/warp sequence, payments are open for at least 1 day
    /// inside every 4-day window.
    function invariant_PaymentsOpenAtLeastOneDayInEveryFourDayWindow() public view {
        (uint256[] memory s, uint256[] memory e) = handler.intervals();
        assertGe(PauseWindow.minOpen(s, e, handler.begin(), veltrio.pauseLockedUntil()), 1 days);
        for (uint256 i; i < s.length; i++) {
            assertLe(e[i] - s[i], 3 days); // no single pause exceeds 3 days
        }
    }

    /// The contract's view of the active pause matches the independently recorded intervals.
    function invariant_PausedViewMatchesRecordedIntervals() public view {
        (uint256[] memory s, uint256[] memory e) = handler.intervals();
        bool expectPaused = s.length > 0 && block.timestamp >= s[s.length - 1] && block.timestamp < e[e.length - 1];
        assertEq(veltrio.paused(), expectPaused);
    }

    function invariant_UnpauseOnlyWhileActivelyPaused() public view {
        assertEq(handler.ghostBadUnpauseAccepted(), 0);
        assertEq(handler.ghostGoodUnpauseRejected(), 0);
    }
}
