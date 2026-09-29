// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Adopted from the IMD swarm review of commit a51f9130 (job 11c42a8c, 2026-09-29): its reproductions became
// regressions once the findings were fixed; the coverage gaps it listed are the unit cases below.

import {Test} from "forge-std/Test.sol";
import {SeatVault, SeatVaultFactory} from "../src/SeatVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {MockERC20} from "./Mocks.sol";
import {MockERC721, MockRegistry} from "./VaultMocks.sol";
import {SafeMintRegistry} from "./SeatVaultReviewProbes.t.sol";

/// @dev A seat collection with the pre-standard `transfer(address,uint256)` some old collections still expose.
contract LegacyTransferCollection is ERC721 {
    constructor() ERC721("Legacy seats", "LSEAT") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function transfer(address to, uint256 id) external returns (bool) {
        _transfer(msg.sender, to, id);
        return true;
    }
}

contract SeatVaultSwarmProbes is Test {
    address internal owner = makeAddr("swarm-owner");
    address internal provider = makeAddr("swarm-provider");
    uint256 internal constant OPERATOR_KEY = 0x5eed;
    uint256 internal constant T0 = 1_800_000_000;
    string internal constant RELAY = "https://relay.invalid";
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;
    MockERC721 internal seats;
    MockERC20 internal reward;
    MockRegistry internal registry;
    SeatVault internal vault;

    function setUp() public {
        vm.warp(T0);
        seats = new MockERC721();
        reward = new MockERC20();
        registry = new MockRegistry();
        seats.mint(owner, 1);
        vault = new SeatVault(
            owner,
            provider,
            vm.addr(OPERATOR_KEY),
            seats,
            1,
            reward,
            3000,
            keccak256("swarm-device"),
            address(registry),
            RELAY
        );
    }

    function _deposit(SeatVault target) internal {
        vm.startPrank(owner);
        seats.approve(address(target), target.tokenId());
        target.deposit();
        vm.stopPrank();
    }

    // ------------------------------------------------------------ F1: the collection and the registry are never a reward

    function test_settleAndClaimRefuseTheSeatCollectionAndTheRegistry() public {
        _deposit(vault);
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        vault.settle(IERC20(address(seats)));
        vm.prank(provider);
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        vault.claim(IERC20(address(seats)));
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        vault.settle(IERC20(address(registry)));
        assertEq(vault.accounted(IERC20(address(seats))), 0, "no ledger entry for the collection");
        assertEq(seats.ownerOf(1), address(vault));
    }

    function test_legacyTransferCollectionCannotBeClaimedAsAReward() public {
        LegacyTransferCollection legacy = new LegacyTransferCollection();
        legacy.mint(owner, 1);
        SeatVault v = new SeatVault(
            owner,
            provider,
            vm.addr(OPERATOR_KEY),
            legacy,
            1,
            reward,
            3000,
            keccak256("swarm-device"),
            address(registry),
            RELAY
        );
        vm.startPrank(owner);
        legacy.approve(address(v), 1);
        v.deposit();
        vm.stopPrank();
        vm.prank(provider);
        vm.expectRevert(SeatVault.UnsupportedToken.selector); // before the fix this moved seat id 1 to the provider
        v.claim(IERC20(address(legacy)));
        assertEq(legacy.ownerOf(1), address(v));
    }

    function test_rescueRefusesTheRewardTokenAndTheZeroAddress() public {
        _deposit(vault);
        reward.mint(address(vault), 100);
        vm.prank(owner);
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        vault.rescueERC721(IERC721(address(reward)), 100, owner);
        vm.prank(owner);
        vm.expectRevert(SeatVault.ZeroAddress.selector);
        vault.rescueERC721(IERC721(address(registry)), 1, address(0));
        vm.prank(owner);
        vm.expectRevert(SeatVault.ZeroAddress.selector);
        vault.withdrawNFT(address(0));
        assertEq(reward.balanceOf(address(vault)), 100);
        assertEq(seats.ownerOf(1), address(vault));
    }

    // ------------------------------------------------------------ F2: the provider cannot kill a vault before it starts

    function test_providerCannotEndBeforeTheSeatArrives() public {
        vm.prank(provider);
        vm.expectRevert(SeatVault.NotHeld.selector);
        vault.end();
        _deposit(vault);
        assertTrue(vault.held(), "the owner could still start the agreement");
        vm.prank(provider);
        vault.end(); // once started, the provider may end
        assertTrue(vault.ended());
        // the owner may always end, started or not
        SeatVault fresh = new SeatVault(
            owner,
            provider,
            vm.addr(OPERATOR_KEY),
            seats,
            2,
            reward,
            3000,
            keccak256("swarm-device"),
            address(registry),
            RELAY
        );
        vm.prank(owner);
        fresh.end();
        assertTrue(fresh.ended());
    }

    // ------------------------------------------------------------ F4: a claim pays what is there, the rest stays allocated

    function test_claimUnderAShortfallPaysWhatIsThereAndKeepsTheRest() public {
        _deposit(vault);
        reward.mint(address(vault), 100);
        vault.settle(reward);
        vm.prank(address(vault));
        reward.transfer(address(0xdead), 50); // stands in for a balance that shrank outside the vault's control
        vm.prank(provider);
        assertEq(vault.claim(reward), 30);
        vm.prank(owner);
        assertEq(vault.claim(reward), 20, "the owner takes the 20 that remain");
        assertEq(vault.claimable(reward, owner), 50);
        assertEq(vault.accounted(reward), 50);
        assertEq(vault.shortfall(reward), 50);
        reward.mint(address(vault), 50); // a top-up restores the balance: nothing new is split, the old allocation is paid
        vm.prank(owner);
        assertEq(vault.claim(reward), 50);
        assertEq(vault.claimable(reward, owner), 0);
        assertEq(reward.balanceOf(address(vault)), 0);
    }

    // ------------------------------------------------------------ F5: only registrations reach the registry

    function test_registerAgentForwardsOnlyTheThreeRegisterSelectors() public {
        SafeMintRegistry safeRegistry = new SafeMintRegistry();
        SeatVault v = new SeatVault(
            owner,
            provider,
            vm.addr(OPERATOR_KEY),
            seats,
            1,
            reward,
            3000,
            keccak256("swarm-device"),
            address(safeRegistry),
            RELAY
        );
        _deposit(v);
        vm.prank(owner);
        v.registerAgent(abi.encodeCall(SafeMintRegistry.register, ()));
        assertEq(safeRegistry.ownerOf(1), address(v));
        address delegate = makeAddr("delegate");
        vm.startPrank(owner);
        vm.expectRevert(SeatVault.NotARegistration.selector);
        v.registerAgent(abi.encodeCall(IERC721.setApprovalForAll, (delegate, true)));
        vm.expectRevert(SeatVault.NotARegistration.selector);
        v.registerAgent(abi.encodeCall(IERC721.transferFrom, (address(v), delegate, 1)));
        vm.expectRevert(SeatVault.NotARegistration.selector);
        v.registerAgent(abi.encodeWithSelector(bytes4(keccak256("setAgentWallet(uint256,address)")), 1, delegate));
        vm.stopPrank();
        assertEq(v.REGISTER_SELECTOR(), bytes4(0x1aa3a008));
        assertEq(v.REGISTER_URI_SELECTOR(), bytes4(0xf2c298be));
        assertEq(v.REGISTER_META_SELECTOR(), bytes4(0x8ea42286));
    }

    function test_registerOverloadsPassTheSelectorCheck() public {
        _deposit(vault);
        vm.startPrank(owner);
        vault.registerAgent(abi.encodeWithSelector(bytes4(0xf2c298be), "ipfs://agent-card"));
        vault.registerAgent(abi.encodeWithSelector(bytes4(0x8ea42286), "ipfs://agent-card", new bytes(0)));
        vm.stopPrank();
        assertEq(registry.lastCaller(), address(vault));
    }

    // ------------------------------------------------------------ F8: the listed coverage gaps

    function test_approvalAtExactlyOneHourIsAccepted() public {
        _deposit(vault);
        vm.prank(owner);
        bytes32 digest = vault.approvePairing(keccak256("edge"), uint64(vm.getBlockTimestamp() + 1 hours), RELAY);
        assertEq(vault.approvedDigest(), digest);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_KEY, digest);
        assertEq(vault.isValidSignature(digest, abi.encodePacked(r, s, v)), MAGIC, "valid at the last second");
    }

    function testFuzz_randomHashesAndSignaturesAreNeverValid(bytes32 hash, bytes memory signature) public {
        _deposit(vault);
        vm.prank(owner);
        bytes32 digest = vault.approvePairing(keccak256("fuzz"), uint64(vm.getBlockTimestamp() + 600), RELAY);
        vm.assume(hash != digest);
        assertEq(vault.isValidSignature(hash, signature), INVALID);
        assertEq(vault.isValidSignature(digest, signature), INVALID, "random bytes never recover to the operator");
    }

    function test_anApprovedOperatorMayDepositOnTheOwnersBehalf() public {
        address helper = makeAddr("helper");
        vm.prank(owner);
        seats.setApprovalForAll(helper, true);
        vm.prank(helper);
        seats.safeTransferFrom(owner, address(vault), 1); // `from` is still the owner, so the seat is accepted
        assertTrue(vault.held());
        assertEq(seats.ownerOf(1), address(vault));
    }
}
