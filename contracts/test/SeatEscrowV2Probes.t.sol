// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Adopted from Codex's second review (2026-09-28, rental model). The reproductions became regressions for the
// fixed behaviour; the witnesses are kept as written. The review's original file is kept locally under review/.

import {Test} from "forge-std/Test.sol";
import {SeatEscrow} from "../src/SeatEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./Mocks.sol";

/// @dev Incoming transfers are exact. Outgoing transfers debit the requested amount but deliver only 99%.
contract RecipientTaxToken is MockERC20 {
    address public escrowAddress;

    function setEscrow(address target) external {
        escrowAddress = target;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == escrowAddress && to != address(0)) {
            uint256 tax = value / 100;
            super._update(from, address(0), tax);
            super._update(from, to, value - tax);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Models an unsupported asset whose balances change outside transfers (a rebase, an upgrade, a lie).
contract BalanceLossToken is MockERC20 {
    function reduceBalance(address target, uint256 amount) external {
        _burn(target, amount);
    }
}

/// @dev Delivers the full transfer but optionally burns another 1% from the sender.
contract IncomingSenderSurchargeToken is MockERC20 {
    address public chargedSender;

    function setChargedSender(address sender) external {
        chargedSender = sender;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == chargedSender && to != address(0)) super._update(from, address(0), value / 100);
    }
}

contract SeatEscrowV2Probes is Test {
    SeatEscrow internal escrow;
    MockERC20 internal token;
    address internal owner = makeAddr("v2-owner");
    address internal provider = makeAddr("v2-provider");
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant DAY = 24 hours;
    uint256 internal constant MAX = type(uint128).max;
    bytes32 internal constant DOC = keccak256("rental review fixture");

    function setUp() public {
        vm.warp(T0);
        escrow = new SeatEscrow();
        _useToken(new MockERC20());
    }

    function _useToken(MockERC20 asset) internal {
        token = asset;
        token.mint(owner, 4 * MAX);
        vm.prank(owner);
        token.approve(address(escrow), type(uint256).max);
    }

    function _active(uint256 fee, uint256 reserve) internal returns (uint256 id) {
        vm.prank(provider);
        id = escrow.propose(owner, provider, IERC20(address(token)), fee, 2000, fee, DOC);
        bytes32 digest = escrow.termsDigest(owner, provider, IERC20(address(token)), fee, 2000, fee, DOC);
        vm.startPrank(owner);
        escrow.approve(id, digest);
        if (reserve > 0) escrow.deposit(id, reserve);
        escrow.activate(id);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ regressions for the review findings

    function test_regression_initialDepositRejectsIncomingSenderSurcharge() public {
        _checkIncomingSurcharge(0);
    }

    function test_regression_topUpRejectsIncomingSenderSurcharge() public {
        _checkIncomingSurcharge(1);
    }

    function test_regression_payFeeRejectsIncomingSenderSurcharge() public {
        _checkIncomingSurcharge(2);
    }

    function test_regression_payShareAfterExitRejectsIncomingSenderSurcharge() public {
        _checkIncomingSurcharge(3);
    }

    function _checkIncomingSurcharge(uint8 operation) internal {
        IncomingSenderSurchargeToken taxed = new IncomingSenderSurchargeToken();
        _useToken(taxed);
        uint256 id;
        if (operation == 0) {
            vm.prank(provider);
            id = escrow.propose(owner, provider, token, 100, 2000, 100, DOC);
        } else {
            id = _active(100, 100);
        }
        uint256 other = _active(0, 200);
        vm.warp(T0 + DAY);
        if (operation == 3) {
            vm.prank(owner);
            escrow.end(id);
        }
        vm.prank(owner);
        token.approve(address(escrow), 500);
        taxed.setChargedSender(owner);
        bytes memory ledgerBefore = abi.encode(escrow.stateOf(id), escrow.stateOf(other));
        uint256 ownerBefore = token.balanceOf(owner);
        uint256 poolBefore = token.balanceOf(address(escrow));
        uint256 supplyBefore = token.totalSupply();

        vm.expectRevert(SeatEscrow.UnsupportedToken.selector);
        vm.prank(owner);
        if (operation < 2) escrow.deposit(id, 100);
        else if (operation == 2) escrow.payFee(id, 100);
        else escrow.payShare(id, 100, keccak256("incoming surcharge regression"));

        assertEq(abi.encode(escrow.stateOf(id), escrow.stateOf(other)), ledgerBefore, "both ledgers roll back");
        assertEq(token.balanceOf(owner), ownerBefore, "sender debit rolls back");
        assertEq(token.balanceOf(address(escrow)), poolBefore, "pooled backing is unchanged");
        assertEq(token.totalSupply(), supplyBefore, "surcharge burn rolls back");
        assertEq(token.allowance(owner, address(escrow)), 500, "allowance consumption rolls back");

        // The same action succeeds once ordinary exact-transfer behavior is restored.
        taxed.setChargedSender(address(0));
        vm.prank(owner);
        if (operation < 2) escrow.deposit(id, 100);
        else if (operation == 2) escrow.payFee(id, 100);
        else escrow.payShare(id, 100, keccak256("incoming surcharge regression"));
        assertEq(token.balanceOf(owner), ownerBefore - 100);
        assertEq(token.balanceOf(address(escrow)), poolBefore + 100);
        assertEq(token.allowance(owner, address(escrow)), 400);
        assertEq(token.totalSupply(), supplyBefore);
        assertEq(escrow.stateOf(other).reserve, 200);
        assertEq(escrow.stateOf(id).providerClaim, operation < 2 ? 0 : 100);
        assertEq(escrow.stateOf(id).feeCredited, operation == 2 ? 100 : 0);
        assertEq(escrow.stateOf(id).reserve, operation == 1 ? 200 : 100);
    }

    function test_regression_claimRefusesShortDeliveryRecipientTax() public {
        RecipientTaxToken taxed = new RecipientTaxToken();
        taxed.setEscrow(address(escrow));
        _useToken(taxed);
        uint256 id = _active(100, 100);
        vm.warp(T0 + DAY);
        vm.startPrank(provider);
        escrow.draw(id);
        vm.expectRevert(SeatEscrow.UnsupportedToken.selector);
        escrow.claim(id);
        vm.stopPrank();
        assertEq(escrow.stateOf(id).providerClaim, 100, "the claim stays recorded until it can be delivered in full");
    }

    function test_regression_refundRefusesShortDeliveryRecipientTax() public {
        RecipientTaxToken taxed = new RecipientTaxToken();
        taxed.setEscrow(address(escrow));
        _useToken(taxed);
        uint256 id = _active(0, 100);
        vm.startPrank(owner);
        escrow.end(id);
        vm.expectRevert(SeatEscrow.UnsupportedToken.selector);
        escrow.refund(id);
        vm.stopPrank();
        assertEq(escrow.stateOf(id).reserve, 100);
    }

    function test_regression_payFeeRespectsTheClaimCap() public {
        uint256 id = _active(1, 1);
        vm.prank(owner);
        escrow.payShare(id, MAX, keccak256("review payout"));
        vm.warp(T0 + DAY);
        vm.prank(owner);
        vm.expectRevert(SeatEscrow.AmountTooLarge.selector);
        escrow.payFee(id, 1);
        vm.prank(provider);
        assertEq(escrow.claim(id), MAX);
        vm.prank(owner);
        escrow.payFee(id, 1); // room again once the provider has claimed
        assertEq(escrow.stateOf(id).providerClaim, 1);
    }

    function test_regression_drawRespectsTheClaimCap() public {
        uint256 id = _active(1, 1);
        vm.prank(owner);
        escrow.payShare(id, MAX, keccak256("review payout"));
        vm.warp(T0 + DAY);
        vm.prank(provider);
        vm.expectRevert(SeatEscrow.AmountTooLarge.selector);
        escrow.draw(id);
        vm.prank(provider);
        assertEq(escrow.claim(id), MAX);
        vm.prank(provider);
        assertEq(escrow.draw(id), 1);
    }

    // ------------------------------------------------------------ witnesses kept from the review

    /// @dev Pooled backing per asset: a token whose balances shrink outside transfers can leave a later claimant
    /// short. The contract cannot detect that; it is why the first product pins one plain ERC-20.
    function test_scope_balanceLossOutsideTransfersCanUnderfundAnotherAgreement() public {
        BalanceLossToken reduced = new BalanceLossToken();
        _useToken(reduced);
        uint256 a = _active(100, 100);
        uint256 b = _active(0, 100);
        reduced.reduceBalance(address(escrow), 10);
        vm.warp(T0 + DAY);
        vm.startPrank(provider);
        escrow.draw(a);
        assertEq(escrow.claim(a), 100);
        vm.stopPrank();
        assertEq(token.balanceOf(address(escrow)), 90);
        assertEq(escrow.stateOf(b).reserve, 100);
        vm.startPrank(owner);
        escrow.end(b);
        vm.expectRevert();
        escrow.refund(b);
        vm.stopPrank();
        assertEq(escrow.stateOf(b).reserve, 100, "a failed refund rolls back its ledger mutation");
    }

    function test_refundThenLatePartialFeeThenDrawThenRefund() public {
        uint256 id = _active(100, 500);
        vm.warp(T0 + 2 * DAY);
        vm.startPrank(owner);
        escrow.end(id);
        assertEq(escrow.refund(id), 300);
        escrow.payFee(id, 50);
        assertEq(escrow.refund(id), 50);
        vm.stopPrank();
        assertEq(escrow.stateOf(id).reserve, 150);
        vm.startPrank(provider);
        assertEq(escrow.draw(id), 150);
        assertEq(escrow.claim(id), 200);
        vm.expectRevert(SeatEscrow.NothingDue.selector);
        escrow.draw(id);
        vm.stopPrank();
        assertEq(escrow.feeOwed(id), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_successfulDrawAndRefundLeaveNoFeeForLatePayment() public {
        uint256 id = _active(100, 500);
        vm.warp(T0 + 2 * DAY);
        vm.prank(provider);
        escrow.end(id);
        vm.prank(provider);
        assertEq(escrow.draw(id), 200);
        vm.startPrank(owner);
        assertEq(escrow.refund(id), 300);
        vm.expectRevert(SeatEscrow.NothingDue.selector);
        escrow.payFee(id, 1);
        vm.expectRevert(SeatEscrow.BadStatus.selector);
        escrow.end(id);
        vm.stopPrank();
    }

    function test_ownerCanDepositBeforeProviderApprovalAndCancel() public {
        vm.startPrank(owner);
        uint256 id = escrow.propose(owner, provider, IERC20(address(token)), 100, 2000, 100, DOC);
        escrow.deposit(id, 500);
        vm.expectRevert(SeatEscrow.NotApproved.selector);
        escrow.activate(id);
        escrow.end(id);
        assertEq(escrow.refund(id), 500);
        vm.expectRevert(SeatEscrow.BadStatus.selector);
        escrow.payShare(id, 1, DOC);
        vm.stopPrank();
        bytes32 digest = escrow.termsOf(id).termsHash;
        vm.prank(provider);
        vm.expectRevert(SeatEscrow.BadStatus.selector);
        escrow.approve(id, digest);
    }

    function test_shareReferencesMayBeZeroOrRepeatedAfterExit() public {
        uint256 id = _active(100, 100);
        vm.startPrank(owner);
        escrow.end(id);
        escrow.payShare(id, 10, bytes32(0));
        escrow.payShare(id, 20, bytes32(0));
        assertEq(escrow.refund(id), 100);
        vm.stopPrank();
        assertEq(escrow.feeOwed(id), 0);
        assertEq(escrow.stateOf(id).providerClaim, 30);
    }

    function test_cumulativeFeeCreditMayExceedInputLimitWithoutOverflow() public {
        uint256 id = _active(MAX, MAX);
        vm.warp(type(uint64).max);
        vm.prank(owner);
        escrow.end(id);
        uint256 expected = MAX * (uint256(type(uint64).max) - T0) / DAY;
        assertEq(escrow.feeAccrued(id), expected);
        vm.prank(provider);
        assertEq(escrow.draw(id), MAX);
        vm.prank(provider);
        assertEq(escrow.claim(id), MAX);
        vm.prank(owner);
        escrow.payFee(id, MAX);
        vm.prank(provider);
        assertEq(escrow.claim(id), MAX);
        assertEq(escrow.stateOf(id).feeCredited, 2 * MAX);
        assertEq(escrow.feeOwed(id), expected - 2 * MAX);
    }
}
