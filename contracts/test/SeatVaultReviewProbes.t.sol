// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Adopted from Codex's 2026-09-28 review of the vault (report kept locally under review/). The reproductions became
// regressions for the fixed behaviour; the witnesses are kept as written.

import {Test} from "forge-std/Test.sol";
import {SeatVault, SeatVaultFactory} from "../src/SeatVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {MockERC20} from "./Mocks.sol";
import {MockERC721, MockRegistry} from "./VaultMocks.sol";

/// @dev A reward token whose balance read can be switched off (an upgrade, a pause, a lie).
contract UnavailableBalanceToken is MockERC20 {
    bool public unavailable;

    function disableBalanceRead() external {
        unavailable = true;
    }

    function balanceOf(address account) public view override returns (uint256) {
        require(!unavailable, "balance unavailable");
        return super.balanceOf(account);
    }
}

/// @dev An identity registry that safe-mints its agent NFT to the caller.
contract SafeMintRegistry is ERC721 {
    constructor() ERC721("Agent", "AGENT") {}

    function register() external returns (uint256) {
        _safeMint(msg.sender, 1);
        return 1;
    }
}

contract RejectingRecipient {}

contract SeatVaultReviewProbes is Test {
    address internal owner = makeAddr("review-owner");
    address internal provider = makeAddr("review-provider");
    uint256 internal constant OPERATOR_KEY = 0x314159;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant TOKEN = 2048;
    bytes32 internal constant DEVICE = keccak256("review-device");
    string internal constant RELAY = "https://api.imd.fun";
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
        seats.mint(owner, TOKEN);
        vault = _newVault(reward, address(registry), TOKEN);
    }

    function _newVault(IERC20 asset, address registryAddress, uint256 tokenId) internal returns (SeatVault) {
        return new SeatVault(
            owner,
            provider,
            vm.addr(OPERATOR_KEY),
            IERC721(address(seats)),
            tokenId,
            asset,
            3000,
            DEVICE,
            registryAddress,
            RELAY,
            0
        );
    }

    function _deposit() internal {
        vm.startPrank(owner);
        seats.approve(address(vault), TOKEN);
        vault.deposit();
        vm.stopPrank();
    }

    function _signature(bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------ F1 custody

    function test_plainTransferThenProviderEndRemainsWithdrawable() public {
        vm.prank(owner);
        seats.transferFrom(owner, address(vault), TOKEN);
        vm.prank(provider);
        vault.end();
        assertEq(seats.ownerOf(TOKEN), address(vault));
        vm.startPrank(owner);
        vm.expectRevert(SeatVault.AlreadyEnded.selector);
        vault.syncHeld(); // pairing bookkeeping is closed, but custody is not
        vm.expectRevert(SeatVault.UseWithdraw.selector);
        vault.rescueERC721(IERC721(address(seats)), TOKEN, owner);
        vault.withdrawNFT(owner);
        vm.stopPrank();
        assertEq(seats.ownerOf(TOKEN), owner);
    }

    function test_plainReturnAfterExitRemainsRecoverable() public {
        _deposit();
        vm.startPrank(owner);
        vault.withdrawNFT(owner);
        seats.transferFrom(owner, address(vault), TOKEN);
        vault.withdrawNFT(owner);
        vm.stopPrank();
        assertEq(seats.ownerOf(TOKEN), owner);
    }

    // ------------------------------------------------------------ F2 reward token cannot hold the seat hostage

    function test_rewardReadFailureDoesNotBlockNFTExit() public {
        UnavailableBalanceToken unavailable = new UnavailableBalanceToken();
        vault = _newVault(unavailable, address(registry), TOKEN);
        _deposit();
        unavailable.disableBalanceRead();
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertEq(seats.ownerOf(TOKEN), owner);
        assertTrue(vault.ended());
    }

    function test_largeStandardTokenBalanceDoesNotBlockNFTExit() public {
        _deposit();
        uint256 amount = type(uint256).max / 7000 + 1;
        reward.mint(address(vault), amount);
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertEq(seats.ownerOf(TOKEN), owner);
        assertEq(vault.accounted(reward), amount, "full-precision split settled the whole balance");
        assertEq(vault.claimable(reward, owner) + vault.claimable(reward, provider), amount);
    }

    // ------------------------------------------------------------ F3 one active approval

    function test_deviceChangeInvalidatesOldPairingApproval() public {
        _deposit();
        vm.startPrank(owner);
        bytes32 digest = vault.approvePairing(keccak256("review-nonce-a"), uint64(T0 + 600), RELAY);
        assertEq(vault.isValidSignature(digest, _signature(digest)), MAGIC);
        vault.setDeviceKey(keccak256("replacement-review-device"));
        vm.stopPrank();
        assertEq(vault.isValidSignature(digest, _signature(digest)), INVALID, "old device is no longer authorized");
        assertEq(vault.approvedUntil(), 0);
    }

    function test_newApprovalReplacesThePreviousOne() public {
        _deposit();
        vm.startPrank(owner);
        bytes32 first = vault.approvePairing(keccak256("review-nonce-a"), uint64(T0 + 600), RELAY);
        bytes32 second = vault.approvePairing(keccak256("review-nonce-b"), uint64(T0 + 600), RELAY);
        vm.stopPrank();
        assertEq(vault.isValidSignature(first, _signature(first)), INVALID, "only the latest approval is live");
        assertEq(vault.isValidSignature(second, _signature(second)), MAGIC);
        assertEq(vault.approvedDigest(), second);
    }

    // ------------------------------------------------------------ F4 registry that safe-mints

    function test_safeMintRegistrationIsReceivableAndRescuable() public {
        SafeMintRegistry safeRegistry = new SafeMintRegistry();
        vault = _newVault(reward, address(safeRegistry), TOKEN);
        _deposit();
        vm.prank(owner);
        vault.registerAgent(abi.encodeCall(SafeMintRegistry.register, ()));
        assertEq(safeRegistry.ownerOf(1), address(vault));
        assertTrue(vault.held(), "the seat bookkeeping was not touched by the agent token");
        vm.prank(owner);
        vault.rescueERC721(IERC721(address(safeRegistry)), 1, owner);
        assertEq(safeRegistry.ownerOf(1), owner);
        assertEq(seats.ownerOf(TOKEN), address(vault), "the seat stayed");
    }

    // ------------------------------------------------------------ P1 / P2 configuration rules

    function test_operatorMustBeADistinctKey() public {
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        new SeatVault(
            owner, provider, owner, IERC721(address(seats)), TOKEN, reward, 3000, DEVICE, address(registry), RELAY, 0
        );
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        new SeatVault(
            owner, provider, provider, IERC721(address(seats)), TOKEN, reward, 3000, DEVICE, address(registry), RELAY, 0
        );
    }

    function test_registryCannotBeTheRewardTokenOrTheCollectionOrEmpty() public {
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        _newVault(reward, address(reward), TOKEN);
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        _newVault(reward, address(seats), TOKEN);
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        _newVault(reward, makeAddr("no code here"), TOKEN);
        vm.expectRevert(SeatVaultFactory.InvalidConfiguration.selector);
        new SeatVaultFactory(IERC721(address(seats)), IERC20(address(reward)), address(reward), RELAY);
    }

    function test_registerAgentRejectsEmptyCalldata() public {
        _deposit();
        vm.prank(owner);
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        vault.registerAgent("");
    }

    // ------------------------------------------------------------ witnesses kept from the review

    function test_rejectingRecipientRollsBackAndEOARetrySucceeds() public {
        _deposit();
        reward.mint(address(vault), 100);
        RejectingRecipient rejector = new RejectingRecipient();
        vm.prank(owner);
        vm.expectRevert();
        vault.withdrawNFT(address(rejector));
        assertTrue(vault.held());
        assertFalse(vault.ended());
        assertEq(vault.accounted(reward), 0, "settlement also rolled back");
        assertEq(seats.ownerOf(TOKEN), address(vault));
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertEq(seats.ownerOf(TOKEN), owner);
        assertEq(vault.claimable(reward, provider), 30);
    }

    function test_sameDigestCanValidateRepeatedlyUntilRevoked() public {
        _deposit();
        vm.prank(owner);
        bytes32 digest = vault.approvePairing(keccak256("review-nonce"), uint64(T0 + 600), RELAY);
        bytes memory signature = _signature(digest);
        assertEq(vault.isValidSignature(digest, signature), MAGIC);
        assertEq(vault.isValidSignature(digest, signature), MAGIC, "the relay must consume its nonce");
        uint256 originalChain = vm.getChainId();
        vm.chainId(originalChain + 1);
        assertEq(vault.isValidSignature(digest, signature), INVALID);
        vm.chainId(originalChain);
        assertEq(vault.isValidSignature(digest, signature), MAGIC);
        vm.prank(owner);
        vault.revokePairing();
        assertEq(vault.isValidSignature(digest, signature), INVALID);
    }

    function test_highSAndInvalidVReturnInvalid() public {
        _deposit();
        vm.prank(owner);
        bytes32 digest = vault.approvePairing(keccak256("review-nonce"), uint64(T0 + 600), RELAY);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_KEY, digest);
        uint256 curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory highS = abi.encodePacked(r, bytes32(curveOrder - uint256(s)), uint8(v == 27 ? 28 : 27));
        assertEq(vault.isValidSignature(digest, highS), INVALID);
        assertEq(vault.isValidSignature(digest, abi.encodePacked(r, s, uint8(0))), INVALID);
    }

    function test_recomputedExpiryDoesNotMatchMinedApproval() public {
        _deposit();
        bytes32 nonce = keccak256("review-nonce");
        vm.prank(owner);
        bytes32 first = vault.approvePairing(nonce, uint64(T0 + 600), RELAY);
        vm.warp(T0 + 12);
        bytes32 rerun = vault.workerAuthorizationDigest(DEVICE, nonce, uint64(T0 + 12 + 600));
        assertTrue(first != rerun);
        assertEq(vault.isValidSignature(first, _signature(first)), MAGIC);
        assertEq(vault.isValidSignature(rerun, _signature(rerun)), INVALID);
    }

    function test_roundingDependsOnSettlementPartitions() public {
        SeatVault batched = _newVault(reward, address(registry), 2049);
        reward.mint(address(batched), 10);
        batched.settle(reward);
        for (uint256 i; i < 10; ++i) {
            reward.mint(address(vault), 1);
            vault.settle(reward);
        }
        assertEq(batched.claimable(reward, owner), 7);
        assertEq(batched.claimable(reward, provider), 3);
        assertEq(vault.claimable(reward, owner), 0);
        assertEq(vault.claimable(reward, provider), 10);
    }

    function test_shortfallIsVisibleWhenATokenShrinks() public {
        _deposit();
        reward.mint(address(vault), 100);
        vault.settle(reward);
        vm.prank(address(vault));
        reward.transfer(address(0xdead), 40); // stands in for a balance that shrank outside the vault's control
        assertEq(vault.shortfall(reward), 40);
        assertEq(vault.pending(reward), 0);
    }
}
