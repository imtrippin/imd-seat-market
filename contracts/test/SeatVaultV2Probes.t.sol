// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Adopted from Codex's second review of the vault (2026-09-28; report kept locally under review/). Withdrawal makes
// no call to the reward token any more, so the review's reproductions became regressions; the witnesses are kept.

import {Test} from "forge-std/Test.sol";
import {SeatVault} from "../src/SeatVault.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {MockERC20} from "./Mocks.sol";
import {MockERC721, MockRegistry} from "./VaultMocks.sol";

/// @dev A reward token whose balance read misbehaves in every way a caller would have to survive.
contract MalformedBalanceToken is MockERC20 {
    uint256 public mode; // 0 honest, 1 empty return, 2 short return, 3 burns all gas, 4 reverts, 5 extra word

    function setMode(uint256 value) external {
        mode = value;
    }

    function balanceOf(address account) public view override returns (uint256) {
        uint256 current = mode;
        if (current == 1) {
            assembly {
                return(0, 0)
            }
        }
        if (current == 2) {
            assembly {
                return(0, 31)
            }
        }
        if (current == 3) {
            assembly {
                for {} 1 {} {}
            }
        }
        if (current == 4) revert("balance unavailable");
        uint256 value = super.balanceOf(account);
        if (current == 5) {
            assembly {
                mstore(0, value)
                mstore(32, 123)
                return(0, 64)
            }
        }
        return value;
    }
}

contract SeatVaultV2Probes is Test {
    address internal owner = makeAddr("v2-owner");
    address internal provider = makeAddr("v2-provider");
    address internal operator = makeAddr("v2-operator");
    uint256 internal constant TOKEN = 2048;
    MockERC721 internal seats;
    MalformedBalanceToken internal reward;
    MockRegistry internal registry;
    SeatVault internal vault;

    function setUp() public {
        vm.warp(1_800_000_000);
        seats = new MockERC721();
        reward = new MalformedBalanceToken();
        registry = new MockRegistry();
        seats.mint(owner, TOKEN);
        vault = _newVault();
    }

    function _newVault() internal returns (SeatVault) {
        return new SeatVault(
            owner,
            provider,
            operator,
            IERC721(address(seats)),
            TOKEN,
            reward,
            3000,
            keccak256("v2-device"),
            address(registry),
            "https://relay.invalid"
        );
    }

    function _deposit() internal {
        vm.startPrank(owner);
        seats.approve(address(vault), TOKEN);
        vault.deposit();
        vm.stopPrank();
    }

    // ------------------------------------------------------------ the seat's return never depends on the reward token

    function test_withdrawalSurvivesEveryMalformedBalanceRead() public {
        uint256[4] memory modes = [uint256(1), 2, 3, 4]; // empty return, short return, gas-burning, reverting
        for (uint256 i; i < modes.length; ++i) {
            vault = _newVault();
            _deposit();
            reward.setMode(modes[i]);
            vm.prank(owner);
            (bool ok,) = address(vault).call{gas: 300_000}(abi.encodeCall(SeatVault.withdrawNFT, (owner)));
            assertTrue(ok, "withdrawal must not call balanceOf");
            assertEq(seats.ownerOf(TOKEN), owner);
            assertTrue(vault.ended());
            reward.setMode(0);
        }
    }

    function test_extraReturnWordDoesNotBlockSettlement() public {
        _deposit();
        reward.mint(address(vault), 100);
        reward.setMode(5);
        vm.prank(owner);
        vault.withdrawNFT(owner);
        vault.settle(reward);
        assertEq(vault.claimable(reward, provider), 30);
        assertEq(seats.ownerOf(TOKEN), owner);
    }

    function test_skippedSettlementPreservesProviderAllocationAfterRecovery() public {
        _deposit();
        reward.mint(address(vault), 100);
        reward.setMode(4);
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertEq(vault.accounted(reward), 0, "nothing was settled while the token was unreadable");
        reward.setMode(0);
        vm.prank(provider);
        vault.claim(reward);
        assertEq(reward.balanceOf(provider), 30);
        assertEq(vault.claimable(reward, owner), 70);
    }

    function test_fullUint256BalanceSplitsWithoutOverflow() public {
        _deposit();
        reward.mint(address(vault), type(uint256).max);
        vm.prank(owner);
        vault.withdrawNFT(owner);
        vault.settle(reward);
        assertEq(vault.accounted(reward), type(uint256).max);
        assertEq(vault.claimable(reward, owner) + vault.claimable(reward, provider), type(uint256).max);
    }

    // ------------------------------------------------------------ custody state machine, two vaults for one seat

    function testFuzz_twoVaultCustodySequencesRemainRecoverable(bytes32 seed) public {
        SeatVault other = _newVault();
        for (uint256 i; i < 32; ++i) {
            seed = keccak256(abi.encode(seed, i));
            SeatVault target = (uint256(seed) & 1) == 0 ? vault : other;
            uint256 action = (uint256(seed) >> 8) % 8;
            address holder = seats.ownerOf(TOKEN);
            if (action == 0 && holder == owner && !target.ended()) {
                vm.startPrank(owner);
                seats.approve(address(target), TOKEN);
                target.deposit();
                vm.stopPrank();
            } else if (action == 1 && holder == owner) {
                vm.prank(owner);
                seats.transferFrom(owner, address(target), TOKEN);
            } else if (action == 2 && !target.ended()) {
                vm.prank(provider);
                target.end();
            } else if (action == 3 && holder == address(target)) {
                vm.prank(owner);
                target.withdrawNFT(owner);
            } else if (action == 4) {
                vm.prank(owner);
                vm.expectRevert(SeatVault.UseWithdraw.selector);
                target.rescueERC721(seats, TOKEN, owner);
            } else if (action == 5 && holder == address(target) && !target.held() && !target.ended()) {
                vm.prank(owner);
                target.syncHeld();
            } else if (action == 6 && holder != owner) {
                // a direct vault-to-vault safe transfer is refused by the receiving vault (from != owner)
                SeatVault current = SeatVault(holder);
                SeatVault destination = holder == address(vault) ? other : vault;
                vm.prank(owner);
                vm.expectRevert(SeatVault.NotOwner.selector);
                current.withdrawNFT(address(destination));
                assertEq(seats.ownerOf(TOKEN), holder, "rejected direct vault transfer must roll back");
            } else if (action == 7) {
                vm.prank(provider);
                vm.expectRevert(SeatVault.NotOwner.selector);
                target.withdrawNFT(provider);
                assertEq(seats.ownerOf(TOKEN), holder);
            }
        }
        address finalHolder = seats.ownerOf(TOKEN);
        if (finalHolder != owner) {
            vm.prank(owner);
            SeatVault(finalHolder).withdrawNFT(owner);
        }
        assertEq(seats.ownerOf(TOKEN), owner);
    }
}
