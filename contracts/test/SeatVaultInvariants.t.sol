// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Handler-driven invariants over the reward ledger of one vault with an honest token (the supported case):
// what is allocated is exactly what is claimable, the vault always backs its allocations, and nothing is minted or
// lost across arrivals, settlements, claims, ends and withdrawals.

import {Test} from "forge-std/Test.sol";
import {SeatVault} from "../src/SeatVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./Mocks.sol";
import {MockERC721, MockRegistry} from "./VaultMocks.sol";

contract VaultHandler is Test {
    SeatVault public vault;
    MockERC20 public token;
    MockERC721 public seats;
    address public owner;
    address public provider;
    uint256 public minted;
    uint256 public paidOut;

    constructor(SeatVault vault_, MockERC20 token_, MockERC721 seats_, address owner_, address provider_) {
        vault = vault_;
        token = token_;
        seats = seats_;
        owner = owner_;
        provider = provider_;
    }

    function arrive(uint256 amount) external {
        amount = bound(amount, 1, 1e24);
        token.mint(address(vault), amount);
        minted += amount;
    }

    function settle() external {
        vault.settle(token);
    }

    function claimAsOwner() external {
        _claim(owner);
    }

    function claimAsProvider() external {
        _claim(provider);
    }

    // Every guard reads the token id before `vm.prank`: the prank covers exactly one external call, and a getter
    // evaluated inside the argument list would consume it (a real defect a reviewer caught in this handler).
    function end() external {
        uint256 id = vault.tokenId();
        if (vault.ended() || seats.ownerOf(id) != address(vault)) return;
        vm.prank(provider);
        vault.end();
    }

    function withdraw() external {
        uint256 id = vault.tokenId();
        if (seats.ownerOf(id) != address(vault)) return;
        vm.prank(owner);
        vault.withdrawNFT(owner);
    }

    function redeposit() external {
        uint256 id = vault.tokenId();
        if (seats.ownerOf(id) != owner) return;
        vm.prank(owner);
        seats.transferFrom(owner, address(vault), id); // a plain return after exit: still withdrawable
    }

    function _claim(address party) internal {
        vault.settle(token);
        if (vault.claimable(token, party) == 0) return;
        vm.prank(party);
        paidOut += vault.claim(token);
    }
}

contract SeatVaultInvariants is Test {
    SeatVault internal vault;
    MockERC20 internal token;
    MockERC721 internal seats;
    VaultHandler internal handler;
    address internal owner = makeAddr("inv-owner");
    address internal provider = makeAddr("inv-provider");

    function setUp() public {
        vm.warp(1_800_000_000);
        seats = new MockERC721();
        token = new MockERC20();
        MockRegistry registry = new MockRegistry();
        seats.mint(owner, 1);
        vault = new SeatVault(
            owner,
            provider,
            makeAddr("inv-operator"),
            seats,
            1,
            token,
            3000,
            keccak256("inv-device"),
            address(registry),
            "https://relay.invalid"
        );
        vm.startPrank(owner);
        seats.approve(address(vault), 1);
        vault.deposit();
        vm.stopPrank();
        handler = new VaultHandler(vault, token, seats, owner, provider);
        targetContract(address(handler));
    }

    /// @dev Deterministic regression: the handler's re-deposit path must actually run (it once consumed its own
    /// prank on a getter and silently reverted every time).
    function test_handlerRedepositReturnsTheSeatAfterExit() public {
        handler.withdraw();
        assertEq(seats.ownerOf(1), owner);
        handler.redeposit();
        assertEq(seats.ownerOf(1), address(vault), "the plain return landed");
        handler.withdraw();
        assertEq(seats.ownerOf(1), owner, "and the seat is recoverable again");
    }

    function invariant_allocationsEqualClaimables() public view {
        assertEq(vault.accounted(token), vault.claimable(token, owner) + vault.claimable(token, provider));
    }

    function invariant_vaultBacksItsAllocations() public view {
        assertGe(token.balanceOf(address(vault)), vault.accounted(token));
        assertEq(vault.shortfall(token), 0);
    }

    function invariant_nothingMintedOrLost() public view {
        assertEq(token.balanceOf(address(vault)) + token.balanceOf(owner) + token.balanceOf(provider), handler.minted());
        assertEq(token.balanceOf(owner) + token.balanceOf(provider), handler.paidOut());
        assertEq(vault.pending(token) + vault.accounted(token), token.balanceOf(address(vault)));
    }

    function invariant_theSeatIsWithTheOwnerOrTheVault() public view {
        address holder = seats.ownerOf(1);
        assertTrue(holder == owner || holder == address(vault), "the seat never goes anywhere else");
    }
}
