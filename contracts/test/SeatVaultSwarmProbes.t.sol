// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Adopted from the IMD swarm review of commit a51f9130 (job 11c42a8c, 2026-09-29): its reproductions became
// regressions once the findings were fixed; the coverage gaps it listed are the unit cases below.

import {Test, Vm} from "forge-std/Test.sol";
import {SeatVault, SeatVaultFactory} from "../src/SeatVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {MockERC20} from "./Mocks.sol";
import {MockERC721, MockRegistrar, SilentRegistrar, AliasedRewardToken, ProxiedCollection} from "./VaultMocks.sol";

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
    MockRegistrar internal registry;
    SeatVault internal vault;

    function setUp() public {
        vm.warp(T0);
        seats = new MockERC721();
        reward = new MockERC20();
        registry = new MockRegistrar();
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

    // ------------------------------------------------------------ F1: only the pinned reward token is ever split

    function test_onlyTheRewardTokenIsSplitOtherTokensAreTheOwnersToRescue() public {
        _deposit(vault);
        MockERC20 other = new MockERC20();
        other.mint(address(vault), 1000);
        reward.mint(address(vault), 100);
        vault.settle();
        assertEq(vault.accounted(), 100, "only the reward token is settled");
        vm.prank(provider);
        assertEq(vault.claim(), 30);
        assertEq(other.balanceOf(provider), 0);
        vm.prank(provider);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.rescueERC20(IERC20(address(other)), provider);
        vm.startPrank(owner);
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        vault.rescueERC20(reward, owner); // rewards leave only through claim
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        vault.rescueERC20(IERC20(address(seats)), owner); // the seat collection is never a rescueERC20 target
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        vault.rescueERC20(IERC20(address(registry)), owner);
        vm.expectRevert(SeatVault.ZeroAddress.selector);
        vault.rescueERC20(IERC20(address(other)), address(0));
        vault.rescueERC20(IERC20(address(other)), owner);
        vm.stopPrank();
        assertEq(other.balanceOf(owner), 1000);
        assertEq(vault.claimable(owner), 70, "the reward ledger is untouched by the rescue");
        assertEq(seats.ownerOf(1), address(vault));
    }

    function test_aStrayLegacyTransferNftCanOnlyLeaveThroughTheOwnersRescue() public {
        _deposit(vault);
        LegacyTransferCollection legacy = new LegacyTransferCollection();
        legacy.mint(address(vault), 1); // a stray token of another collection lands in the vault
        vm.startPrank(provider);
        vm.expectRevert(SeatVault.NothingToClaim.selector);
        vault.claim(); // the third swarm review: claim used to accept the stray as `token` and move id 1
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.rescueERC721(IERC721(address(legacy)), 1, provider);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.rescueERC20(IERC20(address(legacy)), provider);
        vm.stopPrank();
        assertEq(legacy.ownerOf(1), address(vault), "the stray stays until the owner rescues it");
        vm.prank(owner);
        vault.rescueERC721(IERC721(address(legacy)), 1, owner);
        assertEq(legacy.ownerOf(1), owner);
    }

    function test_aLegacyTransferSeatCollectionIsNeverARescueTarget() public {
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
        vm.expectRevert(SeatVault.UnsupportedToken.selector); // would move seat id 1 with the bookkeeping intact
        v.rescueERC20(IERC20(address(legacy)), owner);
        vm.stopPrank();
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

    function test_aRescueCannotTouchTheRewardBalanceThroughASecondEntryPoint() public {
        AliasedRewardToken aliased = new AliasedRewardToken();
        SeatVault v = new SeatVault(
            owner,
            provider,
            vm.addr(OPERATOR_KEY),
            seats,
            1,
            aliased,
            3000,
            keccak256("swarm-device"),
            address(registry),
            RELAY
        );
        _deposit(v);
        aliased.mint(address(v), 100);
        v.settle();
        address entry = address(aliased.entry()); // read before expectRevert: a getter would be "the next call"
        vm.prank(owner);
        vm.expectRevert(SeatVault.UnsupportedToken.selector); // Codex after the third round: this drained the host's share
        v.rescueERC20(IERC20(entry), owner);
        assertEq(aliased.balanceOf(address(v)), 100);
        vm.prank(provider);
        assertEq(v.claim(), 30);
        MockERC20 unrelated = new MockERC20();
        unrelated.mint(address(v), 5);
        vm.prank(owner);
        v.rescueERC20(IERC20(address(unrelated)), owner); // an unrelated asset still leaves
        assertEq(unrelated.balanceOf(owner), 5);
    }

    function test_aRescueCannotMoveTheSeatThroughAProxyOfTheCollection() public {
        ProxiedCollection proxied = new ProxiedCollection();
        proxied.mint(owner, 1);
        SeatVault v = new SeatVault(
            owner,
            provider,
            vm.addr(OPERATOR_KEY),
            proxied,
            1,
            reward,
            3000,
            keccak256("swarm-device"),
            address(registry),
            RELAY
        );
        address entry = address(proxied.entry());
        vm.startPrank(owner);
        proxied.approve(address(v), 1);
        v.deposit();
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        v.rescueERC721(IERC721(entry), 1, owner);
        vm.stopPrank();
        assertEq(proxied.ownerOf(1), address(v));
        assertTrue(v.held());
    }

    function test_rescueERC721RefusesTheRegistrar() public {
        _deposit(vault);
        vm.prank(owner);
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        vault.rescueERC721(IERC721(address(registry)), 1, owner);
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

    function test_providerCannotEndAPlainTransferredSeatUntilTheOwnerRecordsIt() public {
        vm.prank(owner);
        seats.transferFrom(owner, address(vault), 1); // the other supported deposit path: no callback, held stays false
        vm.prank(provider);
        vm.expectRevert(SeatVault.NotHeld.selector); // the third swarm review: this used to close the vault before it started
        vault.end();
        vm.prank(owner);
        vault.syncHeld();
        vm.prank(owner);
        vault.approvePairing(keccak256("n"), uint64(vm.getBlockTimestamp() + 600), RELAY);
        vm.prank(provider);
        vault.end(); // once recorded, the provider may end as before
        assertTrue(vault.ended());
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertEq(seats.ownerOf(1), owner);
    }

    // ------------------------------------------------------------ F3: replacing an approval announces the old one as cleared

    function test_replacingAnApprovalEmitsPairingClearedForTheOldDigest() public {
        _deposit(vault);
        uint64 until = uint64(vm.getBlockTimestamp() + 600);
        vm.prank(owner);
        bytes32 first = vault.approvePairing(keccak256("a"), until, RELAY);
        vm.recordLogs();
        vm.prank(owner);
        bytes32 second = vault.approvePairing(keccak256("b"), until, RELAY);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "PairingCleared(old) then PairingApproved(new)");
        assertEq(logs[0].topics[0], keccak256("PairingCleared(bytes32)"));
        assertEq(logs[0].topics[1], first);
        assertEq(logs[1].topics[0], keccak256("PairingApproved(bytes32,bytes32,bytes32,uint64)"));
        assertEq(logs[1].topics[1], second);
        assertEq(vault.approvedDigest(), second);
        // a first approval announces nothing to clear
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
        seats.mint(owner, 2);
        _deposit(fresh);
        vm.recordLogs();
        vm.prank(owner);
        fresh.approvePairing(keccak256("c"), until, RELAY);
        assertEq(vm.getRecordedLogs().length, 1);
    }

    // ------------------------------------------------------------ F4: a claim pays what is there, the rest stays allocated

    function test_claimUnderAShortfallPaysWhatIsThereAndKeepsTheRest() public {
        _deposit(vault);
        reward.mint(address(vault), 100);
        vault.settle();
        vm.prank(address(vault));
        reward.transfer(address(0xdead), 50); // stands in for a balance that shrank outside the vault's control
        vm.prank(provider);
        assertEq(vault.claim(), 30);
        vm.prank(owner);
        assertEq(vault.claim(), 20, "the owner takes the 20 that remain");
        assertEq(vault.claimable(owner), 50);
        assertEq(vault.accounted(), 50);
        assertEq(vault.shortfall(), 50);
        reward.mint(address(vault), 50); // a top-up restores the balance: nothing new is split, the old allocation is paid
        vm.prank(owner);
        assertEq(vault.claim(), 50);
        assertEq(vault.claimable(owner), 0);
        assertEq(reward.balanceOf(address(vault)), 0);
    }

    // ------------------------------------------------------------ F5: only this seat's registration reaches the registrar

    function _registration(uint256 seatId) internal view returns (bytes memory) {
        return abi.encodeWithSelector(vault.REGISTER_SELECTOR(), uint8(0), address(seats), seatId, "ipfs://agent-card");
    }

    function test_registerAgentForwardsOnlyTheRegistrarsRegisterSelectorsForThisSeat() public {
        _deposit(vault);
        assertEq(vault.REGISTER_SELECTOR(), bytes4(0xb68ca002));
        assertEq(vault.REGISTER_META_SELECTOR(), bytes4(0x1fd8046a));
        bytes memory good = _registration(1);
        bytes memory otherSeat = _registration(2);
        bytes memory otherCollection = abi.encodeWithSelector(
            vault.REGISTER_SELECTOR(), uint8(0), address(reward), uint256(1), "ipfs://agent-card"
        );
        bytes memory otherStandard = abi.encodeWithSelector(
            vault.REGISTER_SELECTOR(), uint8(1), address(seats), uint256(1), "ipfs://agent-card"
        );
        bytes memory tooShort = abi.encodeWithSelector(vault.REGISTER_SELECTOR(), uint8(0), address(seats));
        address delegate = makeAddr("delegate");
        vm.startPrank(owner);
        vm.expectRevert(SeatVault.NotARegistration.selector);
        vault.registerAgent(abi.encodeCall(IERC721.setApprovalForAll, (delegate, true)));
        vm.expectRevert(SeatVault.NotARegistration.selector);
        vault.registerAgent(abi.encodeWithSignature("setAgentURI(uint256,string)", uint256(1), "ipfs://x"));
        vm.expectRevert(SeatVault.NotARegistration.selector);
        vault.registerAgent(
            abi.encodeWithSignature("setAgentWallet(uint256,address,uint256,bytes)", 1, delegate, 0, "")
        );
        vm.expectRevert(SeatVault.WrongToken.selector);
        vault.registerAgent(otherSeat);
        vm.expectRevert(SeatVault.WrongToken.selector);
        vault.registerAgent(otherCollection);
        vm.expectRevert(SeatVault.WrongToken.selector);
        vault.registerAgent(otherStandard);
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        vault.registerAgent(tooShort);
        uint256 agentId = vault.registerAgent(good);
        vm.stopPrank();
        assertEq(registry.lastCaller(), address(vault), "the holder, the vault, is the registrar's caller");
        assertEq(registry.ownerOf(agentId), address(registry), "the registrar keeps the agent NFT");
        assertTrue(registry.isController(agentId, address(vault)));
    }

    function test_registerWithMetadataPassesTheSelectorCheck() public {
        _deposit(vault);
        MockRegistrar.MetadataEntry[] memory entries = new MockRegistrar.MetadataEntry[](1);
        entries[0] = MockRegistrar.MetadataEntry("k", "v");
        bytes memory data = abi.encodeWithSelector(
            vault.REGISTER_META_SELECTOR(), uint8(0), address(seats), uint256(1), "ipfs://agent-card", entries
        );
        vm.prank(owner);
        vault.registerAgent(data);
        assertEq(registry.lastCaller(), address(vault));
    }

    function test_agentControlFollowsTheSeat() public {
        _deposit(vault);
        bytes memory data = _registration(1);
        vm.prank(owner);
        uint256 agentId = vault.registerAgent(data);
        assertTrue(registry.isController(agentId, address(vault)));
        assertFalse(registry.isController(agentId, owner));
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertTrue(registry.isController(agentId, owner), "control follows the seat out of the vault");
        assertFalse(registry.isController(agentId, address(vault)));
    }

    function test_reservedBindingMetadataIsRefusedByTheRegistrar() public {
        _deposit(vault);
        MockRegistrar.MetadataEntry[] memory entries = new MockRegistrar.MetadataEntry[](1);
        entries[0] = MockRegistrar.MetadataEntry(registry.BINDING_KEY(), hex"abcd");
        bytes memory data = abi.encodeWithSelector(
            vault.REGISTER_META_SELECTOR(), uint8(0), address(seats), uint256(1), "ipfs://agent-card", entries
        );
        vm.prank(owner);
        vm.expectRevert(SeatVault.RegistryCallFailed.selector);
        vault.registerAgent(data);
        assertEq(registry.agentCount(), 0, "no agent was created");
    }

    function test_downstreamRegistrationFailureUnwindsAndCannotBlockExit() public {
        _deposit(vault);
        registry.setFailAfterRegister(true);
        bytes memory data = _registration(1);
        vm.prank(owner);
        vm.expectRevert(SeatVault.RegistryCallFailed.selector);
        vault.registerAgent(data);
        assertEq(registry.agentCount(), 0, "the failed registration left nothing behind");
        registry.setFailAfterRegister(false);
        vm.prank(owner);
        uint256 agentId = vault.registerAgent(data);
        assertEq(registry.getAgentWallet(agentId), address(0), "the registrar clears the agent wallet");
        assertEq(registry.bindingMetadata(agentId), abi.encodePacked(address(registry)));
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertEq(seats.ownerOf(1), owner);
    }

    function test_registrarMustReturnTheAgentId() public {
        // a registrar implementation that swallows the call through a bare fallback registers nothing; the vault
        // refuses its empty answer (a shape check, not proof of what a registration meant)
        SilentRegistrar silent = new SilentRegistrar();
        SeatVault quiet = new SeatVault(
            owner,
            provider,
            vm.addr(OPERATOR_KEY),
            seats,
            1,
            reward,
            3000,
            keccak256("swarm-device"),
            address(silent),
            RELAY
        );
        _deposit(quiet);
        bytes memory data = _registration(1);
        vm.prank(owner);
        vm.expectRevert(SeatVault.RegistryCallFailed.selector);
        quiet.registerAgent(data);
        assertEq(seats.ownerOf(1), address(quiet));
        vm.prank(owner);
        quiet.withdrawNFT(owner);
        assertEq(seats.ownerOf(1), owner);
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
