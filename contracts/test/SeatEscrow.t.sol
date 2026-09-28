// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SeatEscrow} from "../src/SeatEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20, FeeOnTransferERC20} from "./Mocks.sol";

contract SeatEscrowTest is Test {
    SeatEscrow escrow;
    MockERC20 token;
    address owner = makeAddr("owner");
    address provider = makeAddr("provider");
    address stranger = makeAddr("stranger");

    uint256 constant DAY = 24 hours;
    uint256 constant FEE = 1e18; // 1 token per day
    uint16 constant SHARE = 2000; // 20%, informational
    uint256 constant DEPOSIT = 1e18; // one day of fee, the listing's minimum
    bytes32 constant DOC = keccak256("seat 2048 / wallet demo / service terms v1");

    function setUp() public {
        vm.warp(1_800_000_000);
        escrow = new SeatEscrow();
        token = new MockERC20();
        token.mint(owner, 1_000e18);
        vm.prank(owner);
        token.approve(address(escrow), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _digest(IERC20 asset, uint256 fee, uint16 share, uint256 required) internal view returns (bytes32) {
        return escrow.termsDigest(owner, provider, asset, fee, share, required, DOC);
    }

    function _propose(uint256 fee, uint16 share, uint256 required) internal returns (uint256 id) {
        vm.prank(provider);
        id = escrow.propose(owner, provider, IERC20(address(token)), fee, share, required, DOC);
        bytes32 digest = _digest(IERC20(address(token)), fee, share, required);
        vm.prank(owner);
        escrow.approve(id, digest);
    }

    function _active(uint256 fee, uint256 depositAmount) internal returns (uint256 id) {
        id = _propose(fee, SHARE, fee);
        vm.startPrank(owner);
        if (depositAmount > 0) escrow.deposit(id, depositAmount);
        escrow.activate(id);
        vm.stopPrank();
    }

    function _reserve(uint256 id) internal view returns (uint256) {
        return escrow.stateOf(id).reserve;
    }

    function _claim(uint256 id) internal view returns (uint256) {
        return escrow.stateOf(id).providerClaim;
    }

    // ---------------------------------------------------------------- setup and roles

    function test_proposeApproveActivate() public {
        uint256 id = _propose(FEE, SHARE, DEPOSIT);
        assertEq(id, 1);
        assertEq(uint256(escrow.stateOf(id).status), uint256(SeatEscrow.Status.Proposed));
        SeatEscrow.Terms memory t = escrow.termsOf(id);
        assertEq(t.dailyFee, FEE);
        assertEq(t.shareBps, SHARE);
        assertEq(t.requiredDeposit, DEPOSIT);
        vm.startPrank(owner);
        vm.expectRevert(SeatEscrow.DepositRequired.selector);
        escrow.activate(id);
        escrow.deposit(id, DEPOSIT - 1);
        vm.expectRevert(SeatEscrow.DepositRequired.selector);
        escrow.activate(id);
        escrow.deposit(id, 1);
        escrow.activate(id);
        vm.expectRevert(SeatEscrow.BadStatus.selector);
        escrow.activate(id);
        vm.stopPrank();
        assertEq(uint256(escrow.stateOf(id).status), uint256(SeatEscrow.Status.Active));
        assertEq(escrow.feeAccrued(id), 0);
        assertEq(_reserve(id), DEPOSIT);
    }

    function test_approvalCommitsToTheExactMoneyTerms() public {
        vm.prank(provider);
        uint256 id = escrow.propose(owner, provider, IERC20(address(token)), FEE, SHARE, DEPOSIT, DOC);
        bytes32 digest = _digest(IERC20(address(token)), FEE, SHARE, DEPOSIT);
        assertEq(escrow.termsOf(id).termsHash, digest);
        bytes32 otherFee = _digest(IERC20(address(token)), FEE + 1, SHARE, DEPOSIT);
        bytes32 otherShare = _digest(IERC20(address(token)), FEE, SHARE + 1, DEPOSIT);
        vm.startPrank(owner);
        vm.expectRevert(SeatEscrow.TermsMismatch.selector);
        escrow.approve(id, DOC); // the bare document hash is not the digest
        vm.expectRevert(SeatEscrow.TermsMismatch.selector);
        escrow.approve(id, otherFee);
        vm.expectRevert(SeatEscrow.TermsMismatch.selector);
        escrow.approve(id, otherShare);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(SeatEscrow.NotParty.selector);
        escrow.approve(id, digest);
        vm.prank(provider);
        vm.expectRevert(SeatEscrow.AlreadyApproved.selector);
        escrow.approve(id, digest);
        vm.prank(provider);
        vm.expectRevert(SeatEscrow.NotOwner.selector);
        escrow.activate(id);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.NotApproved.selector);
        escrow.activate(id);
    }

    function test_invalidTermsRejected() public {
        IERC20 t = IERC20(address(token));
        vm.startPrank(provider);
        vm.expectRevert(SeatEscrow.InvalidTerms.selector);
        escrow.propose(owner, provider, t, FEE, SHARE, FEE - 1, DOC); // deposit below one day of fee
        vm.expectRevert(SeatEscrow.InvalidTerms.selector);
        escrow.propose(owner, provider, t, FEE, 10_001, DEPOSIT, DOC); // share above 100%
        vm.expectRevert(SeatEscrow.InvalidTerms.selector);
        escrow.propose(provider, provider, t, FEE, SHARE, DEPOSIT, DOC);
        vm.expectRevert(SeatEscrow.InvalidTerms.selector);
        escrow.propose(owner, provider, t, FEE, SHARE, DEPOSIT, bytes32(0));
        vm.expectRevert(SeatEscrow.InvalidTerms.selector);
        escrow.propose(owner, provider, IERC20(address(0)), FEE, SHARE, DEPOSIT, DOC);
        vm.expectRevert(SeatEscrow.InvalidTerms.selector);
        escrow.propose(owner, provider, t, uint256(type(uint128).max) + 1, SHARE, type(uint256).max, DOC);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(SeatEscrow.NotParty.selector);
        escrow.propose(owner, provider, t, FEE, SHARE, DEPOSIT, DOC);
    }

    function test_roleGuards() public {
        uint256 id = _active(FEE, DEPOSIT);
        vm.startPrank(provider);
        vm.expectRevert(SeatEscrow.NotOwner.selector);
        escrow.deposit(id, 1);
        vm.expectRevert(SeatEscrow.NotOwner.selector);
        escrow.payFee(id, 1);
        vm.expectRevert(SeatEscrow.NotOwner.selector);
        escrow.payShare(id, 1, bytes32(0));
        vm.expectRevert(SeatEscrow.NotOwner.selector);
        escrow.refund(id);
        vm.stopPrank();
        vm.startPrank(owner);
        vm.expectRevert(SeatEscrow.NotProvider.selector);
        escrow.draw(id);
        vm.expectRevert(SeatEscrow.NotProvider.selector);
        escrow.claim(id);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(SeatEscrow.NotParty.selector);
        escrow.end(id);
    }

    // ---------------------------------------------------------------- the fee clock

    function test_feeAccruesPerSecondAndFloors() public {
        uint256 id = _active(FEE, DEPOSIT);
        vm.warp(block.timestamp + 12 hours);
        assertEq(escrow.feeAccrued(id), FEE / 2);
        vm.warp(block.timestamp + 12 hours);
        assertEq(escrow.feeAccrued(id), FEE);
        vm.warp(block.timestamp + 1 seconds);
        assertEq(escrow.feeAccrued(id), FEE + FEE / DAY);
        assertEq(escrow.feeOwed(id), escrow.feeAccrued(id));
    }

    function test_feeFreezesAtExit() public {
        uint256 id = _active(FEE, DEPOSIT);
        vm.warp(block.timestamp + 36 hours);
        vm.prank(provider);
        escrow.end(id);
        uint256 frozen = escrow.feeAccrued(id);
        assertEq(frozen, FEE * 3 / 2);
        vm.warp(block.timestamp + 30 * DAY);
        assertEq(escrow.feeAccrued(id), frozen);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.BadStatus.selector);
        escrow.end(id);
    }

    // ---------------------------------------------------------------- the owner's scenarios

    function test_ownerStopsPaying_hostEndsAndKeepsTheDeposit() public {
        uint256 id = _active(FEE, DEPOSIT);
        // day 1: owner pays as they go, deposit untouched
        vm.warp(block.timestamp + DAY);
        vm.prank(owner);
        escrow.payFee(id, FEE);
        assertEq(escrow.feeOwed(id), 0);
        assertEq(_reserve(id), DEPOSIT);
        // day 2: the owner disappears; the unpaid fee reaches the deposit
        vm.warp(block.timestamp + DAY);
        assertEq(escrow.feeOwed(id), FEE);
        assertEq(escrow.unsecured(id), 0);
        vm.startPrank(provider);
        escrow.end(id);
        assertEq(escrow.draw(id), DEPOSIT);
        assertEq(escrow.claim(id), 2 * FEE, "day one paid plus day two from the deposit");
        vm.stopPrank();
        assertEq(escrow.feeOwed(id), 0);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.NothingRefundable.selector);
        escrow.refund(id);
    }

    function test_hostLossIsBoundedByWhatAccruesBeyondTheDeposit() public {
        uint256 id = _active(FEE, DEPOSIT);
        vm.warp(block.timestamp + 36 hours); // the host waited half a day too long
        assertEq(escrow.unsecured(id), FEE / 2);
        vm.startPrank(provider);
        escrow.end(id);
        assertEq(escrow.draw(id), DEPOSIT);
        vm.stopPrank();
        assertEq(escrow.feeOwed(id), FEE / 2, "half a day is unpaid and only voluntarily payable");
        vm.prank(owner);
        escrow.payFee(id, FEE / 2); // a late owner can still settle after exit
        assertEq(escrow.feeOwed(id), 0);
        assertEq(_claim(id), FEE * 3 / 2);
    }

    function test_normalExit_ownerGetsTheDepositBackImmediately() public {
        uint256 id = _active(FEE, DEPOSIT);
        vm.warp(block.timestamp + 5 * DAY);
        vm.prank(owner);
        escrow.payFee(id, 5 * FEE);
        vm.prank(owner);
        escrow.end(id);
        uint256 before = token.balanceOf(owner);
        vm.prank(owner);
        assertEq(escrow.refund(id), DEPOSIT);
        assertEq(token.balanceOf(owner) - before, DEPOSIT);
        assertEq(_reserve(id), 0);
        vm.prank(provider);
        assertEq(escrow.claim(id), 5 * FEE);
    }

    function test_prepaidBalance_hostDrawsDailyAndTheRestRefunds() public {
        uint256 id = _active(FEE, 7 * FEE); // a week in advance, no daily transactions for the owner
        for (uint256 day = 1; day <= 3; ++day) {
            vm.warp(block.timestamp + DAY);
            vm.prank(provider);
            assertEq(escrow.draw(id), FEE);
        }
        assertEq(_reserve(id), 4 * FEE);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(owner);
        escrow.end(id);
        assertEq(escrow.refundable(id), 4 * FEE - FEE / 2);
        vm.prank(owner);
        assertEq(escrow.refund(id), 4 * FEE - FEE / 2);
        vm.prank(provider);
        assertEq(escrow.draw(id), FEE / 2, "the last half day stays reserved for the host");
        assertEq(_reserve(id), 0);
    }

    // ---------------------------------------------------------------- shares

    function test_shareIsVoluntaryReferencedAndNeverCountsAgainstFee() public {
        uint256 id = _active(FEE, DEPOSIT);
        vm.warp(block.timestamp + DAY);
        bytes32 payoutTx = keccak256("0x74906756 reward tx");
        vm.expectEmit(true, true, false, true);
        emit SeatEscrow.SharePaid(id, 6e17, payoutTx);
        vm.prank(owner);
        escrow.payShare(id, 6e17, payoutTx);
        assertEq(escrow.feeOwed(id), FEE, "the share did not pay the fee");
        assertEq(_claim(id), 6e17);
        assertEq(_reserve(id), DEPOSIT);
        vm.prank(owner);
        escrow.end(id);
        vm.prank(owner);
        escrow.payShare(id, 1e17, keccak256("late payout")); // still possible after exit
        vm.prank(provider);
        assertEq(escrow.claim(id), 7e17);
    }

    function test_pureRevenueShareListingNeedsNoDeposit() public {
        uint256 id = _propose(0, 4000, 0);
        vm.prank(owner);
        escrow.activate(id);
        vm.warp(block.timestamp + 10 * DAY);
        assertEq(escrow.feeOwed(id), 0);
        vm.prank(provider);
        vm.expectRevert(SeatEscrow.NothingDue.selector);
        escrow.draw(id);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.NothingDue.selector);
        escrow.payFee(id, 1);
        vm.prank(owner);
        escrow.payShare(id, 2e18, keccak256("payout"));
        vm.prank(provider);
        assertEq(escrow.claim(id), 2e18);
    }

    // ---------------------------------------------------------------- payment and draw caps

    function test_payFeeCappedByOwedAndNeverPrepays() public {
        uint256 id = _active(FEE, DEPOSIT);
        vm.warp(block.timestamp + DAY);
        vm.startPrank(owner);
        vm.expectRevert(SeatEscrow.ExceedsDue.selector);
        escrow.payFee(id, FEE + 1);
        escrow.payFee(id, FEE / 4);
        escrow.payFee(id, FEE * 3 / 4);
        vm.expectRevert(SeatEscrow.NothingDue.selector);
        escrow.payFee(id, 1);
        vm.stopPrank();
        vm.warp(block.timestamp + DAY);
        assertEq(escrow.feeOwed(id), FEE, "the next day is owed again");
    }

    function test_drawCappedByReserve() public {
        uint256 id = _active(FEE, DEPOSIT);
        vm.warp(block.timestamp + 3 * DAY);
        vm.prank(provider);
        assertEq(escrow.draw(id), DEPOSIT);
        assertEq(escrow.feeOwed(id), 2 * FEE);
        vm.prank(provider);
        vm.expectRevert(SeatEscrow.NothingDue.selector);
        escrow.draw(id);
        vm.prank(owner);
        escrow.deposit(id, 5 * FEE); // a top-up is separate and never pays by itself
        assertEq(escrow.feeOwed(id), 2 * FEE);
        vm.prank(provider);
        assertEq(escrow.draw(id), 2 * FEE);
        assertEq(_reserve(id), 3 * FEE);
    }

    function test_claimSurvivesExitAndDepositsStopAtExit() public {
        uint256 id = _active(FEE, DEPOSIT);
        vm.warp(block.timestamp + DAY);
        vm.prank(provider);
        escrow.draw(id);
        vm.prank(owner);
        escrow.end(id);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.BadStatus.selector);
        escrow.deposit(id, 1);
        vm.warp(block.timestamp + 30 * DAY);
        vm.prank(provider);
        assertEq(escrow.claim(id), FEE);
        vm.prank(provider);
        vm.expectRevert(SeatEscrow.NothingToClaim.selector);
        escrow.claim(id);
    }

    function test_neverActivatedEndsAndRefundsInFull() public {
        uint256 id = _propose(FEE, SHARE, DEPOSIT);
        vm.prank(owner);
        escrow.deposit(id, DEPOSIT);
        vm.prank(provider);
        escrow.end(id);
        assertEq(escrow.feeAccrued(id), 0);
        vm.prank(owner);
        assertEq(escrow.refund(id), DEPOSIT);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.BadStatus.selector);
        escrow.activate(id);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.BadStatus.selector);
        escrow.payFee(id, 1);
    }

    // ---------------------------------------------------------------- tokens and bounds

    function test_feeOnTransferTokenRejected() public {
        FeeOnTransferERC20 fee = new FeeOnTransferERC20();
        fee.mint(owner, 100e18);
        vm.prank(provider);
        uint256 id = escrow.propose(owner, provider, IERC20(address(fee)), FEE, SHARE, DEPOSIT, DOC);
        bytes32 digest = _digest(IERC20(address(fee)), FEE, SHARE, DEPOSIT);
        vm.startPrank(owner);
        escrow.approve(id, digest);
        fee.approve(address(escrow), type(uint256).max);
        vm.expectRevert(SeatEscrow.UnsupportedToken.selector);
        escrow.deposit(id, DEPOSIT);
        vm.stopPrank();
    }

    function test_amountBoundsHold() public {
        uint256 id = _active(FEE, DEPOSIT);
        vm.startPrank(owner);
        vm.expectRevert(SeatEscrow.AmountZero.selector);
        escrow.deposit(id, 0);
        vm.expectRevert(SeatEscrow.AmountTooLarge.selector);
        escrow.deposit(id, uint256(type(uint128).max) + 1);
        vm.expectRevert(SeatEscrow.AmountTooLarge.selector);
        escrow.payShare(id, uint256(type(uint128).max) + 1, bytes32(0));
        vm.stopPrank();
    }

    function test_maximumRateOverTheWholeTimeRangeStaysComputable() public {
        uint256 maxFee = type(uint128).max;
        token.mint(owner, maxFee);
        uint256 id = _propose(maxFee, 10_000, maxFee);
        vm.startPrank(owner);
        escrow.deposit(id, maxFee);
        escrow.activate(id);
        vm.stopPrank();
        uint256 startedAt = block.timestamp;
        vm.warp(type(uint64).max);
        assertEq(escrow.feeAccrued(id), maxFee * (type(uint64).max - startedAt) / DAY);
        vm.prank(provider);
        assertEq(escrow.draw(id), maxFee);
        vm.prank(owner);
        escrow.end(id);
        assertEq(escrow.refundable(id), 0);
    }

    function test_escrowBalanceCoversEveryAgreement() public {
        uint256 a = _active(FEE, DEPOSIT);
        uint256 b = _active(FEE, 3 * FEE);
        vm.warp(block.timestamp + DAY);
        vm.prank(provider);
        escrow.draw(a);
        vm.prank(owner);
        escrow.payShare(b, 5e17, keccak256("payout"));
        SeatEscrow.State memory sa = escrow.stateOf(a);
        SeatEscrow.State memory sb = escrow.stateOf(b);
        assertEq(token.balanceOf(address(escrow)), sa.reserve + sa.providerClaim + sb.reserve + sb.providerClaim);
    }

    // ---------------------------------------------------------------- differential fuzz of the fee clock

    /// @dev Random warps, payments and draws; the accrued fee must always equal a naive per-second computation and
    /// the settled fee must never exceed it.
    function testFuzz_feeClockMatchesNaiveComputation(uint256 dailyFee, uint256[6] memory steps) public {
        dailyFee = bound(dailyFee, 0, 1_000e18);
        token.mint(owner, 100_000e18);
        uint256 id = _propose(dailyFee, SHARE, dailyFee);
        vm.startPrank(owner);
        if (dailyFee > 0) escrow.deposit(id, dailyFee);
        escrow.activate(id);
        vm.stopPrank();
        uint256 startedAt = vm.getBlockTimestamp();
        uint256 endedAt;
        for (uint256 i; i < steps.length; ++i) {
            uint256 s = steps[i];
            vm.warp(vm.getBlockTimestamp() + bound(s % 1_000_003, 0, 3 * DAY));
            uint256 kind = (s / 1_000_003) % 4;
            uint256 until = endedAt == 0 ? vm.getBlockTimestamp() : endedAt;
            uint256 expected = dailyFee * (until - startedAt) / DAY;
            assertEq(escrow.feeAccrued(id), expected);
            if (kind == 0 && escrow.feeOwed(id) > 0) {
                uint256 amount = bound(s / 7, 1, escrow.feeOwed(id));
                vm.prank(owner);
                escrow.payFee(id, amount);
            } else if (kind == 1 && escrow.feeOwed(id) > 0 && escrow.stateOf(id).reserve > 0) {
                vm.prank(provider);
                escrow.draw(id);
            } else if (kind == 2 && endedAt == 0 && i == steps.length - 2) {
                vm.prank(provider);
                escrow.end(id);
                endedAt = vm.getBlockTimestamp();
            }
            assertLe(escrow.stateOf(id).feeCredited, escrow.feeAccrued(id));
        }
    }
}
