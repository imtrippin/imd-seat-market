// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SeatEscrow} from "../src/SeatEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./Mocks.sol";

/// @dev Drives one agreement through random deposits, fee payments, share payments, draws, claims, exits, refunds
/// and time warps. Ghost totals mirror the invariants the prototype's JavaScript model checks. Reverted calls
/// change nothing.
contract Handler is Test {
    SeatEscrow public escrow;
    MockERC20 public token;
    uint256 public id;
    address public owner = makeAddr("owner");
    address public provider = makeAddr("provider");
    bytes32 constant DOC = keccak256("invariant terms");

    uint256 public depositsIn;
    uint256 public feesIn;
    uint256 public sharesIn;
    uint256 public drawsTotal;
    uint256 public claimsOut;
    uint256 public refundsOut;
    uint256 public lastAccrued;
    bool public ended;
    uint256 public accruedAtEnd;

    constructor(SeatEscrow escrow_, MockERC20 token_, uint256 dailyFee, uint256 requiredDeposit) {
        escrow = escrow_;
        token = token_;
        vm.prank(provider);
        id = escrow.propose(owner, provider, IERC20(address(token)), dailyFee, 2000, requiredDeposit, DOC);
        bytes32 digest =
            escrow.termsDigest(owner, provider, IERC20(address(token)), dailyFee, 2000, requiredDeposit, DOC);
        vm.prank(owner);
        escrow.approve(id, digest);
        token.mint(owner, 1_000_000e18);
        vm.prank(owner);
        token.approve(address(escrow), type(uint256).max);
    }

    function _after() internal {
        uint256 a = escrow.feeAccrued(id);
        if (a > lastAccrued) lastAccrued = a;
    }

    function warp(uint256 by) external {
        vm.warp(block.timestamp + bound(by, 0, 5 days));
        _after();
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 100e18);
        vm.prank(owner);
        try escrow.deposit(id, amount) {
            depositsIn += amount;
        } catch {}
        _after();
    }

    function activate() external {
        vm.prank(owner);
        try escrow.activate(id) {} catch {}
        _after();
    }

    function payFee(uint256 amount) external {
        amount = bound(amount, 1, 200e18);
        vm.prank(owner);
        try escrow.payFee(id, amount) {
            feesIn += amount;
        } catch {}
        _after();
    }

    function payShare(uint256 amount, bytes32 payoutRef) external {
        amount = bound(amount, 1, 50e18);
        vm.prank(owner);
        try escrow.payShare(id, amount, payoutRef) {
            sharesIn += amount;
        } catch {}
        _after();
    }

    function draw() external {
        vm.prank(provider);
        try escrow.draw(id) returns (uint256 amount) {
            drawsTotal += amount;
        } catch {}
        _after();
    }

    function claim() external {
        vm.prank(provider);
        try escrow.claim(id) returns (uint256 amount) {
            claimsOut += amount;
        } catch {}
        _after();
    }

    function end(bool byOwner) external {
        vm.prank(byOwner ? owner : provider);
        try escrow.end(id) {
            ended = true;
            accruedAtEnd = escrow.feeAccrued(id);
        } catch {}
        _after();
    }

    function refund() external {
        vm.prank(owner);
        try escrow.refund(id) returns (uint256 amount) {
            refundsOut += amount;
        } catch {}
        _after();
    }
}

contract SeatEscrowInvariants is Test {
    SeatEscrow escrow;
    MockERC20 token;
    Handler handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        escrow = new SeatEscrow();
        token = new MockERC20();
        handler = new Handler(escrow, token, 1e18, 1e18);
        targetContract(address(handler));
    }

    function _state() internal view returns (SeatEscrow.State memory) {
        return escrow.stateOf(handler.id());
    }

    function invariant_escrowHoldsExactlyReserveAndClaim() public view {
        SeatEscrow.State memory s = _state();
        assertEq(token.balanceOf(address(escrow)), s.reserve + s.providerClaim);
    }

    function invariant_cashConservation() public view {
        SeatEscrow.State memory s = _state();
        assertEq(
            handler.depositsIn() + handler.feesIn() + handler.sharesIn(),
            s.reserve + s.providerClaim + handler.claimsOut() + handler.refundsOut()
        );
    }

    function invariant_feeNeverSettledBeyondAccrual() public view {
        SeatEscrow.State memory s = _state();
        assertLe(s.feeCredited, escrow.feeAccrued(handler.id()));
        assertEq(s.feeCredited, handler.feesIn() + handler.drawsTotal());
    }

    function invariant_everythingPaidToTheProviderIsClaimableOrClaimed() public view {
        // fee payments, draws and share payments all land in the claim; nothing else does
        assertEq(
            handler.sharesIn() + handler.feesIn() + handler.drawsTotal(), _state().providerClaim + handler.claimsOut()
        );
    }

    function invariant_accruedFeeMonotone() public view {
        assertGe(escrow.feeAccrued(handler.id()), handler.lastAccrued());
    }

    function invariant_refundKeepsUnpaidFeeReserved() public view {
        if (handler.refundsOut() == 0) return;
        // after a refund, whatever fee is still owed is either fully reserved or the reserve is exhausted
        SeatEscrow.State memory s = _state();
        uint256 owed = escrow.feeOwed(handler.id());
        assertTrue(s.reserve >= owed || escrow.refundable(handler.id()) == 0);
    }

    function invariant_feeFrozenAfterExit() public view {
        if (!handler.ended()) return;
        assertEq(escrow.feeAccrued(handler.id()), handler.accruedAtEnd());
    }
}
