// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Probes adopted from Codex's 2026-09-28 review of the earlier floor-model contract, carried over to the rental
// model: token callbacks against every money entrypoint, outbound-tax tokens, same-block sequences.

import {Test} from "forge-std/Test.sol";
import {SeatEscrow} from "../src/SeatEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MockERC20} from "./Mocks.sol";

/// @dev Incoming transfers are exact, but outgoing transfers debit an extra 1% from the sender.
contract OutboundTaxToken is MockERC20 {
    address public escrowAddress;

    function setEscrow(address target) external {
        escrowAddress = target;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == escrowAddress && to != address(0)) super._update(from, address(0), value / 100);
    }
}

/// @dev Re-enters every money entrypoint from inside a transfer and counts the reentrancy-guard rejections.
contract CallbackToken is MockERC20 {
    SeatEscrow public target;
    uint256 public id;
    uint256 public blocked;
    bool public allGuardErrors = true;

    function arm(SeatEscrow target_, uint256 id_) external {
        target = target_;
        id = id_;
        blocked = 0;
    }

    function _try(bytes memory data) internal {
        (bool ok, bytes memory reason) = address(target).call(data);
        if (!ok && bytes4(reason) == ReentrancyGuard.ReentrancyGuardReentrantCall.selector) blocked++;
        else allGuardErrors = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(target) == address(0)) return;
        _try(abi.encodeCall(SeatEscrow.deposit, (id, 1)));
        _try(abi.encodeCall(SeatEscrow.payFee, (id, 1)));
        _try(abi.encodeCall(SeatEscrow.payShare, (id, 1, bytes32(0))));
        _try(abi.encodeCall(SeatEscrow.draw, (id)));
        _try(abi.encodeCall(SeatEscrow.claim, (id)));
        _try(abi.encodeCall(SeatEscrow.refund, (id)));
    }
}

contract SeatEscrowReviewProbes is Test {
    SeatEscrow internal escrow;
    MockERC20 internal token;
    address internal owner = makeAddr("review-owner");
    address internal provider = makeAddr("review-provider");
    bytes32 internal constant DOC = keccak256("review fixture");
    uint256 internal constant DAY = 24 hours;
    uint256 internal constant T0 = 1_800_000_000;

    function setUp() public {
        vm.warp(T0);
        escrow = new SeatEscrow();
        token = new MockERC20();
        token.mint(owner, 1_000_000e18);
        vm.prank(owner);
        token.approve(address(escrow), type(uint256).max);
    }

    function _active(uint256 daily, uint256 reserve) internal returns (uint256 id) {
        vm.prank(provider);
        id = escrow.propose(owner, provider, IERC20(address(token)), daily, 2000, daily, DOC);
        vm.startPrank(owner);
        escrow.approve(id, escrow.termsDigest(owner, provider, IERC20(address(token)), daily, 2000, daily, DOC));
        if (reserve != 0) escrow.deposit(id, reserve);
        escrow.activate(id);
        vm.stopPrank();
    }

    function test_allSixMoneyEntrypointsBlockTokenCallbacks() public {
        CallbackToken hooked = new CallbackToken();
        token = hooked;
        token.mint(owner, 100e18);
        vm.prank(owner);
        token.approve(address(escrow), type(uint256).max);
        uint256 id = _active(1e18, 2e18);
        hooked.arm(escrow, id);
        vm.prank(owner);
        escrow.deposit(id, 1e18);
        assertEq(hooked.blocked(), 6);
        vm.warp(T0 + DAY);
        vm.prank(owner);
        escrow.payFee(id, 1e18);
        assertEq(hooked.blocked(), 12);
        vm.prank(owner);
        escrow.payShare(id, 1e17, keccak256("payout"));
        assertEq(hooked.blocked(), 18);
        vm.warp(T0 + 2 * DAY);
        vm.prank(provider);
        escrow.draw(id);
        vm.prank(provider);
        escrow.claim(id);
        assertEq(hooked.blocked(), 24);
        vm.prank(owner);
        escrow.end(id);
        vm.prank(owner);
        escrow.refund(id);
        assertEq(hooked.blocked(), 30);
        assertTrue(hooked.allGuardErrors());
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_outgoingTaxTokenCannotSpendAnotherAgreementsDeposit() public {
        OutboundTaxToken taxed = new OutboundTaxToken();
        taxed.setEscrow(address(escrow));
        token = taxed;
        token.mint(owner, 300e18);
        vm.prank(owner);
        token.approve(address(escrow), type(uint256).max);
        uint256 a = _active(100e18, 100e18);
        uint256 b = _active(0, 100e18);
        vm.warp(T0 + DAY);
        vm.startPrank(provider);
        escrow.draw(a);
        vm.expectRevert(SeatEscrow.UnsupportedToken.selector);
        escrow.claim(a); // would debit 101 for a 100 claim and leave B short
        vm.stopPrank();
        assertEq(escrow.stateOf(a).providerClaim, 100e18, "claim stays funded, nothing left the escrow");
        assertEq(token.balanceOf(address(escrow)), escrow.stateOf(a).providerClaim + escrow.stateOf(b).reserve);
        vm.prank(owner);
        escrow.end(b);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.UnsupportedToken.selector);
        escrow.refund(b);
    }

    function test_sameBlockActivationEndDrawAndRefund() public {
        uint256 id = _active(1e18, 3e18);
        vm.prank(provider);
        escrow.end(id);
        assertEq(escrow.feeAccrued(id), 0);
        vm.prank(provider);
        vm.expectRevert(SeatEscrow.NothingDue.selector);
        escrow.draw(id);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.BadStatus.selector);
        escrow.end(id);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.BadStatus.selector);
        escrow.deposit(id, 1);
        vm.prank(owner);
        assertEq(escrow.refund(id), 3e18);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_refundThenLatePaymentThenNothingLeft() public {
        uint256 id = _active(1e18, 1e18);
        vm.warp(T0 + 36 hours);
        vm.prank(owner);
        escrow.end(id);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.NothingRefundable.selector);
        escrow.refund(id); // 1.5 owed against a 1.0 deposit
        vm.prank(provider);
        assertEq(escrow.draw(id), 1e18);
        vm.prank(owner);
        escrow.payFee(id, 5e17);
        assertEq(escrow.feeOwed(id), 0);
        vm.prank(provider);
        assertEq(escrow.claim(id), 15e17);
        assertEq(token.balanceOf(address(escrow)), 0);
    }
}
