// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SeatVault} from "../../src/SeatVault.sol";
import {MockERC721, MockRegistrar} from "../VaultMocks.sol";
import {MockERC20} from "../Mocks.sol";
import {RejectingRecipient} from "../SeatVaultReviewProbes.t.sol";
import {MalformedBalanceToken} from "../SeatVaultV2Probes.t.sol";

/// @dev Additional positive coverage and design witnesses; no real-chain fork or transactions. Registration goes
/// through a registrar mock that behaves like IMD's Adapter8004 (the agent stays with the registrar, control follows
/// the seat).
contract SeatVaultRound3 is Test {
    address internal owner = makeAddr("round3-owner");
    address internal provider = makeAddr("round3-provider");
    uint256 internal constant OPERATOR_KEY = 0x72345;
    uint256 internal constant TOKEN = 42;
    bytes32 internal constant DEVICE = keccak256("round3-device");
    string internal constant RELAY = "https://relay.invalid";
    MockERC721 internal seats;
    MockERC20 internal reward;
    MockRegistrar internal registry;
    SeatVault internal vault;

    function setUp() public {
        vm.warp(1_800_000_000);
        seats = new MockERC721();
        reward = new MockERC20();
        registry = new MockRegistrar();
        seats.mint(owner, TOKEN);
        vault = _newVault(3000);
    }

    function _newVault(uint16 bps) internal returns (SeatVault) {
        return new SeatVault(
            owner, provider, vm.addr(OPERATOR_KEY), seats, TOKEN, reward, bps, DEVICE, address(registry), RELAY
        );
    }

    function _deposit() internal {
        vm.startPrank(owner);
        seats.approve(address(vault), TOKEN);
        vault.deposit();
        vm.stopPrank();
    }

    function _registration() internal view returns (bytes memory) {
        return abi.encodeWithSelector(vault.REGISTER_SELECTOR(), uint8(0), address(seats), TOKEN, "ipfs://agent-card");
    }

    function _approveAndRegister() internal returns (bytes32 digest, bytes memory signature, uint256 agentId) {
        bytes memory data = _registration();
        vm.startPrank(owner);
        digest = vault.approvePairing(keccak256("round3-nonce"), uint64(vm.getBlockTimestamp() + 600), RELAY);
        agentId = vault.registerAgent(data);
        vm.stopPrank();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_KEY, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function test_rejectedExitWithLiveApprovalAndAgentCanRetrySafely() public {
        _deposit();
        (bytes32 digest, bytes memory signature, uint256 agentId) = _approveAndRegister();
        reward.mint(address(vault), 100);
        RejectingRecipient rejector = new RejectingRecipient();
        vm.prank(owner);
        vm.expectRevert();
        vault.withdrawNFT(address(rejector));
        assertEq(seats.ownerOf(TOKEN), address(vault));
        assertTrue(registry.isController(agentId, address(vault)));
        assertFalse(vault.ended());
        assertTrue(vault.held());
        assertEq(vault.isValidSignature(digest, signature), bytes4(0x1626ba7e));
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertEq(seats.ownerOf(TOKEN), owner);
        assertTrue(registry.isController(agentId, owner), "control of the agent follows the seat");
        assertEq(vault.isValidSignature(digest, signature), bytes4(0xffffffff));
        assertEq(vault.accounted(reward), 0, "NFT exit intentionally did not settle");
        vm.prank(provider);
        vault.claim(reward);
        assertEq(reward.balanceOf(provider), 30);
    }

    function test_providerEndWithAgentAndBurningRewardReadCannotBlockExit() public {
        MalformedBalanceToken hostile = new MalformedBalanceToken();
        reward = hostile;
        vault = _newVault(3000);
        _deposit();
        (,, uint256 agentId) = _approveAndRegister();
        hostile.setMode(3);
        vm.prank(provider);
        vault.end();
        vm.prank(owner);
        (bool ok,) = address(vault).call{gas: 200_000}(abi.encodeCall(SeatVault.withdrawNFT, (owner)));
        assertTrue(ok);
        assertEq(seats.ownerOf(TOKEN), owner);
        assertTrue(registry.isController(agentId, owner));
    }

    function test_registrarCallsStopAtEndAndControlPassesWithTheSeat() public {
        _deposit();
        (,, uint256 agentId) = _approveAndRegister();
        vm.prank(provider);
        vault.end();
        bytes memory data = _registration();
        vm.prank(owner);
        vm.expectRevert(SeatVault.AlreadyEnded.selector);
        vault.registerAgent(data);
        assertTrue(registry.isController(agentId, address(vault)), "still the vault's while the seat is inside");
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertTrue(registry.isController(agentId, owner));
    }

    function test_registrarCalldataCannotAuthorizeAnAgentTransfer() public {
        _deposit();
        _approveAndRegister();
        address delegate = makeAddr("round3-agent-delegate");
        vm.prank(owner);
        vm.expectRevert(SeatVault.NotARegistration.selector); // only the registrar's register selectors go through
        vault.registerAgent(abi.encodeCall(IERC721.setApprovalForAll, (delegate, true)));
        assertEq(seats.ownerOf(TOKEN), address(vault));
    }

    function test_artifactSchemaAcceptanceCannotReplaceVaultPreflight() public {
        _deposit();
        vm.prank(owner);
        vm.expectRevert(SeatVault.BadExpiry.selector);
        vault.approvePairing(keccak256("too-far"), uint64(vm.getBlockTimestamp() + 7200), RELAY);
        (bytes32 digest, bytes memory signature,) = _approveAndRegister();
        vm.chainId(vm.getChainId() + 1);
        assertEq(vault.isValidSignature(digest, signature), bytes4(0xffffffff));
    }

    function test_removingOneWithdrawalSettlementBoundaryCanCostOneProviderBaseUnit() public {
        _deposit();
        SeatVault partitioned = _newVault(3000);
        reward.mint(address(vault), 1);
        reward.mint(address(partitioned), 1);
        partitioned.settle(reward);
        vm.prank(owner);
        vault.withdrawNFT(owner);
        reward.mint(address(vault), 1);
        reward.mint(address(partitioned), 1);
        vault.settle(reward);
        partitioned.settle(reward);
        assertEq(vault.claimable(reward, provider), 1);
        assertEq(partitioned.claimable(reward, provider), 2);
    }

    function testFuzz_roundingBoundsAcrossSettlementPartitions(bytes32 seed, uint16 rawBps) public {
        uint16 bps = uint16(bound(rawBps, 0, 10_000));
        vault = _newVault(bps);
        SeatVault batch = _newVault(bps);
        uint256 n = 1 + (uint256(seed) % 32);
        uint256 total;
        uint256 sumFloors;
        for (uint256 i; i < n; ++i) {
            seed = keccak256(abi.encode(seed, i));
            uint256 received = 1 + (uint256(seed) % 1e24);
            uint256 prior = vault.claimable(reward, provider);
            reward.mint(address(vault), received);
            vault.settle(reward);
            uint256 actual = vault.claimable(reward, provider) - prior;
            uint256 floor = Math.mulDiv(received, bps, 10_000);
            assertGe(actual, floor);
            assertLe(actual - floor, 1);
            sumFloors += floor;
            total += received;
        }
        reward.mint(address(batch), total);
        batch.settle(reward);
        uint256 splitHost = vault.claimable(reward, provider);
        uint256 batchHost = batch.claimable(reward, provider);
        assertGe(batchHost, sumFloors, "batching never underpays the sum of per-arrival floors");
        assertGe(splitHost, batchHost);
        assertLe(splitHost - batchHost, n - 1);
        assertEq(batchHost + batch.claimable(reward, owner), total);
        assertEq(splitHost + vault.claimable(reward, owner), total);
    }
}
