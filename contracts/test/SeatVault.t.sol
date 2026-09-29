// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SeatVault, SeatVaultFactory} from "../src/SeatVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {MockERC20} from "./Mocks.sol";
import {
    MockERC721,
    MockRegistrar,
    ReenteringRewardToken,
    RecipientTaxRewardToken,
    ShrinkingRewardToken
} from "./VaultMocks.sol";

/// @dev The test plays IMD's relay: it computes the WorkerAuthorization digest the way `/pair/complete` would
/// (independently of the vault's own helper) and asks the holder contract whether a signature is valid.
contract SeatVaultTest is Test {
    SeatVaultFactory factory;
    SeatVault vault;
    MockERC721 seats;
    MockERC20 imd;
    MockRegistrar registry;

    address owner = makeAddr("owner");
    address provider = makeAddr("provider");
    address stranger = makeAddr("stranger");
    uint256 constant OPERATOR_KEY = 0xA11CE;
    uint256 constant OTHER_KEY = 0xB0B;
    address operator;
    uint256 constant TOKEN = 2048;
    uint16 constant PROVIDER_BPS = 3000;
    bytes32 constant DEVICE = keccak256("host device public key");
    string constant RELAY = "https://api.imd.fun";
    bytes4 constant MAGIC = 0x1626ba7e;
    bytes4 constant INVALID = 0xffffffff;

    function setUp() public {
        vm.warp(1_800_000_000);
        operator = vm.addr(OPERATOR_KEY);
        seats = new MockERC721();
        imd = new MockERC20();
        registry = new MockRegistrar();
        factory = new SeatVaultFactory(IERC721(address(seats)), IERC20(address(imd)), address(registry), RELAY);
        seats.mint(owner, TOKEN);
        vm.prank(owner);
        vault = factory.create(provider, operator, TOKEN, PROVIDER_BPS, DEVICE);
    }

    // ---------------------------------------------------------------- helpers

    function _deposit() internal {
        vm.startPrank(owner);
        seats.approve(address(vault), TOKEN);
        vault.deposit();
        vm.stopPrank();
    }

    /// @dev IMD-side digest: domain (IdentityMD Worker, 2, chainid, NFT contract), message with the holder as wallet.
    function _relayDigest(address wallet, bytes32 device, bytes32 nonce, uint64 expiresAt, string memory relay)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("IdentityMD Worker"),
                keccak256("2"),
                vm.getChainId(),
                address(seats)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "WorkerAuthorization(bytes32 deviceKey,address wallet,uint256 tokenId,bytes32 nonce,uint64 expiresAt,string relayOrigin)"
                ),
                device,
                wallet,
                TOKEN,
                nonce,
                expiresAt,
                keccak256(bytes(relay))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _reward(uint256 amount) internal {
        imd.mint(address(vault), amount); // what a Disperse transfer to the holder looks like from the vault's side
    }

    // ---------------------------------------------------------------- custody

    function test_depositOnlyTheAgreedTokenFromTheOwner() public {
        seats.mint(stranger, 7);
        seats.mint(owner, 9);
        vm.prank(stranger);
        vm.expectRevert(SeatVault.WrongToken.selector);
        seats.safeTransferFrom(stranger, address(vault), 7);
        vm.prank(owner);
        seats.transferFrom(owner, stranger, TOKEN);
        vm.prank(stranger);
        vm.expectRevert(SeatVault.NotOwner.selector);
        seats.safeTransferFrom(stranger, address(vault), TOKEN); // the right token, the wrong depositor
        vm.prank(stranger);
        seats.transferFrom(stranger, owner, TOKEN);
        vm.prank(owner);
        vm.expectRevert(SeatVault.WrongToken.selector);
        seats.safeTransferFrom(owner, address(vault), 9);
        MockERC721 other = new MockERC721();
        other.mint(owner, TOKEN);
        vm.prank(owner);
        other.safeTransferFrom(owner, address(vault), TOKEN); // another collection's token is accepted (rescuable)
        assertEq(other.ownerOf(TOKEN), address(vault));
        assertFalse(vault.held(), "an other-collection token never counts as the seat");
        vm.prank(stranger);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.deposit();
        assertFalse(vault.held());
        _deposit();
        assertTrue(vault.held());
        assertEq(seats.ownerOf(TOKEN), address(vault));
    }

    function test_plainTransferNeedsSyncAndOnlyWhenActuallyHeld() public {
        vm.prank(stranger);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.syncHeld();
        vm.prank(owner);
        vm.expectRevert(SeatVault.NotHeld.selector);
        vault.syncHeld();
        vm.prank(owner);
        seats.transferFrom(owner, address(vault), TOKEN);
        assertFalse(vault.held());
        vm.prank(owner);
        vault.syncHeld();
        assertTrue(vault.held());
    }

    function test_ownerWithdrawsWithoutProviderAndItEndsTheAgreement() public {
        _deposit();
        vm.prank(provider);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.withdrawNFT(provider);
        vm.prank(stranger);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.withdrawNFT(stranger);
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertEq(seats.ownerOf(TOKEN), owner);
        assertFalse(vault.held());
        assertTrue(vault.ended());
        // a vault is one agreement: the NFT cannot come back in
        vm.startPrank(owner);
        seats.approve(address(vault), TOKEN);
        vm.expectRevert(SeatVault.AlreadyEnded.selector);
        vault.deposit();
        vm.stopPrank();
    }

    function test_providerCanEndButCannotMoveTheNFT() public {
        _deposit();
        vm.prank(provider);
        vault.end();
        assertTrue(vault.ended());
        assertEq(seats.ownerOf(TOKEN), address(vault));
        vm.prank(provider);
        vm.expectRevert(SeatVault.AlreadyEnded.selector);
        vault.end();
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertEq(seats.ownerOf(TOKEN), owner);
    }

    // ---------------------------------------------------------------- pairing authority (ERC-1271)

    function test_pairingValidOnlyForApprovedDigestSignedByOperatorOrOwner() public {
        _deposit();
        bytes32 nonce = keccak256("imd nonce");
        uint64 expiresAt = uint64(block.timestamp + 600);
        bytes32 digest = _relayDigest(address(vault), DEVICE, nonce, expiresAt, RELAY);
        // nothing approved yet
        assertEq(vault.isValidSignature(digest, _sign(OPERATOR_KEY, digest)), INVALID);
        vm.prank(provider);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.approvePairing(nonce, expiresAt, RELAY);
        vm.prank(owner);
        bytes32 approved = vault.approvePairing(nonce, expiresAt, RELAY);
        assertEq(approved, digest, "the vault computes the same digest the relay does");
        assertEq(vault.isValidSignature(digest, _sign(OPERATOR_KEY, digest)), MAGIC);
        assertEq(vault.isValidSignature(digest, _sign(OTHER_KEY, digest)), INVALID, "unknown signer");
        assertEq(vault.isValidSignature(digest, hex"deadbeef"), INVALID, "malformed signature never reverts");
        assertEq(vault.isValidSignature(digest, ""), INVALID);
        // the owner may complete the pairing itself
        uint256 ownerKey = 0xC0FFEE;
        address ownerAddr = vm.addr(ownerKey);
        seats.mint(ownerAddr, 3);
        vm.prank(ownerAddr);
        SeatVault v2 = factory.create(provider, operator, 3, PROVIDER_BPS, DEVICE);
        vm.startPrank(ownerAddr);
        seats.approve(address(v2), 3);
        v2.deposit();
        bytes32 d2 = v2.approvePairing(nonce, expiresAt, RELAY);
        vm.stopPrank();
        assertEq(v2.isValidSignature(d2, _sign(ownerKey, d2)), MAGIC);
    }

    function test_pairingRefusesOtherDeviceRelayTokenWalletChainAndArbitraryHashes() public {
        _deposit();
        bytes32 nonce = keccak256("imd nonce");
        uint64 expiresAt = uint64(block.timestamp + 600);
        vm.prank(owner);
        vault.approvePairing(nonce, expiresAt, RELAY);
        bytes32 good = _relayDigest(address(vault), DEVICE, nonce, expiresAt, RELAY);
        bytes32 otherDevice = _relayDigest(address(vault), keccak256("rogue device"), nonce, expiresAt, RELAY);
        bytes32 otherRelay = _relayDigest(address(vault), DEVICE, nonce, expiresAt, "https://evil.example");
        bytes32 otherWallet = _relayDigest(owner, DEVICE, nonce, expiresAt, RELAY);
        bytes32 otherNonce = _relayDigest(address(vault), DEVICE, keccak256("replayed nonce"), expiresAt, RELAY);
        bytes32 arbitrary = keccak256("please sign this transfer");
        assertEq(vault.isValidSignature(good, _sign(OPERATOR_KEY, good)), MAGIC);
        assertEq(vault.isValidSignature(otherDevice, _sign(OPERATOR_KEY, otherDevice)), INVALID);
        assertEq(vault.isValidSignature(otherRelay, _sign(OPERATOR_KEY, otherRelay)), INVALID);
        assertEq(vault.isValidSignature(otherWallet, _sign(OPERATOR_KEY, otherWallet)), INVALID);
        assertEq(vault.isValidSignature(otherNonce, _sign(OPERATOR_KEY, otherNonce)), INVALID);
        assertEq(vault.isValidSignature(arbitrary, _sign(OPERATOR_KEY, arbitrary)), INVALID);
        // the owner cannot be talked into approving a pairing for another relay
        vm.prank(owner);
        vm.expectRevert(SeatVault.WrongRelay.selector);
        vault.approvePairing(nonce, expiresAt, "https://evil.example");
        // a different chain changes the domain, so the same approval is not valid there
        vm.chainId(8453);
        assertEq(vault.isValidSignature(good, _sign(OPERATOR_KEY, good)), INVALID, "digest was for another chain");
        bytes32 baseDigest = _relayDigest(address(vault), DEVICE, nonce, expiresAt, RELAY);
        assertTrue(baseDigest != good);
        assertEq(vault.isValidSignature(baseDigest, _sign(OPERATOR_KEY, baseDigest)), INVALID, "never approved there");
    }

    function test_pairingExpiryWindowRevocationExitAndDeviceChange() public {
        _deposit();
        bytes32 nonce = keccak256("imd nonce");
        vm.startPrank(owner);
        vm.expectRevert(SeatVault.BadExpiry.selector);
        vault.approvePairing(nonce, uint64(vm.getBlockTimestamp()), RELAY); // already expired
        vm.expectRevert(SeatVault.BadExpiry.selector);
        vault.approvePairing(nonce, uint64(vm.getBlockTimestamp() + 1 hours + 1), RELAY); // beyond the window
        uint64 expiresAt = uint64(vm.getBlockTimestamp() + 900); // the script's default
        bytes32 digest = vault.approvePairing(nonce, expiresAt, RELAY);
        vm.stopPrank();
        assertEq(vault.isValidSignature(digest, _sign(OPERATOR_KEY, digest)), MAGIC);
        vm.warp(expiresAt);
        assertEq(vault.isValidSignature(digest, _sign(OPERATOR_KEY, digest)), MAGIC, "valid at the last second");
        vm.warp(expiresAt + 1);
        assertEq(vault.isValidSignature(digest, _sign(OPERATOR_KEY, digest)), INVALID, "expired");
        // a fresh approval, then revoked before use
        vm.warp(expiresAt + 2);
        vm.prank(owner);
        bytes32 second = vault.approvePairing(keccak256("nonce 2"), uint64(block.timestamp + 600), RELAY);
        assertEq(vault.isValidSignature(second, _sign(OPERATOR_KEY, second)), MAGIC);
        assertEq(vault.approvedDigest(), second, "one active approval at a time");
        vm.prank(owner);
        vault.revokePairing();
        assertEq(vault.isValidSignature(second, _sign(OPERATOR_KEY, second)), INVALID);
        // device replacement: only the new device's digest can be approved
        vm.prank(owner);
        vault.setDeviceKey(keccak256("replacement device"));
        vm.prank(owner);
        bytes32 third = vault.approvePairing(keccak256("nonce 3"), uint64(block.timestamp + 600), RELAY);
        assertEq(
            third,
            _relayDigest(
                address(vault),
                keccak256("replacement device"),
                keccak256("nonce 3"),
                uint64(block.timestamp + 600),
                RELAY
            )
        );
        // after exit nothing validates and nothing can be approved
        vm.prank(provider);
        vault.end();
        assertEq(vault.isValidSignature(third, _sign(OPERATOR_KEY, third)), INVALID, "ended");
        vm.prank(owner);
        vm.expectRevert(SeatVault.NotPairable.selector);
        vault.approvePairing(keccak256("nonce 4"), uint64(block.timestamp + 600), RELAY);
        vm.prank(owner);
        vm.expectRevert(SeatVault.AlreadyEnded.selector);
        vault.setDeviceKey(keccak256("another"));
    }

    function test_pairingNeedsTheNFTInTheVault() public {
        bytes32 nonce = keccak256("imd nonce");
        vm.prank(owner);
        vm.expectRevert(SeatVault.NotPairable.selector);
        vault.approvePairing(nonce, uint64(block.timestamp + 600), RELAY);
        _deposit();
        vm.prank(owner);
        bytes32 digest = vault.approvePairing(nonce, uint64(block.timestamp + 600), RELAY);
        assertEq(vault.isValidSignature(digest, _sign(OPERATOR_KEY, digest)), MAGIC);
        vm.prank(owner);
        vault.withdrawNFT(owner);
        assertEq(vault.isValidSignature(digest, _sign(OPERATOR_KEY, digest)), INVALID, "NFT gone, approval dead");
    }

    function test_registerAgentOnlyOwnerOnlyRegistrar() public {
        _deposit();
        bytes memory data =
            abi.encodeWithSelector(vault.REGISTER_SELECTOR(), uint8(0), address(seats), TOKEN, "ipfs://agent-card");
        vm.prank(provider);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.registerAgent(data);
        vm.expectEmit(true, false, false, true, address(vault));
        emit SeatVault.AgentRegistered(1, data);
        vm.prank(owner);
        assertEq(vault.registerAgent(data), 1, "the registrar's agent id is returned and recorded");
        assertEq(registry.lastCaller(), address(vault), "the holder, not the owner, is the registrar's caller");
        assertEq(registry.lastData(), data);
        registry.setFail(true);
        vm.prank(owner);
        vm.expectRevert(SeatVault.RegistryCallFailed.selector);
        vault.registerAgent(data);
        registry.setFail(false);
        vm.prank(provider);
        vault.end();
        vm.prank(owner);
        vm.expectRevert(SeatVault.AlreadyEnded.selector);
        vault.registerAgent(data); // the facility closes with the agreement
    }

    // ---------------------------------------------------------------- rewards

    function test_rewardsSplitByImmutableTermsWithRemainderToProvider() public {
        _deposit();
        _reward(100e18);
        assertEq(vault.pending(), 100e18);
        vault.settle();
        assertEq(vault.claimable(owner), 70e18);
        assertEq(vault.claimable(provider), 30e18);
        assertEq(vault.pending(), 0);
        _reward(1);
        vault.settle();
        assertEq(vault.claimable(owner), 70e18, "one unit rounds to the provider");
        assertEq(vault.claimable(provider), 30e18 + 1);
        _reward(3);
        vault.settle();
        assertEq(vault.claimable(owner), 70e18 + 2);
        assertEq(vault.claimable(provider), 30e18 + 2);
    }

    function test_repeatedSettlementNeverDoubleCounts() public {
        _deposit();
        _reward(50e18);
        vault.settle();
        vault.settle();
        vm.prank(stranger);
        vault.settle();
        assertEq(vault.claimable(owner), 35e18);
        assertEq(vault.claimable(provider), 15e18);
        assertEq(vault.accounted(), 50e18);
    }

    function test_claimOrderingAndNoSweeping() public {
        _deposit();
        _reward(100e18);
        // the provider claims before anyone settled: the claim settles first
        vm.prank(provider);
        assertEq(vault.claim(), 30e18);
        assertEq(imd.balanceOf(provider), 30e18);
        assertEq(vault.claimable(owner), 70e18, "the owner's allocation is untouched");
        // more rewards arrive before the owner claims
        _reward(10e18);
        vm.prank(owner);
        assertEq(vault.claim(), 77e18);
        assertEq(vault.claimable(provider), 3e18);
        vm.prank(owner);
        vm.expectRevert(SeatVault.NothingToClaim.selector);
        vault.claim();
        vm.prank(stranger);
        vm.expectRevert(SeatVault.NotParty.selector);
        vault.claim();
        assertEq(imd.balanceOf(address(vault)), 3e18, "exactly the provider's remaining allocation stays");
        assertEq(vault.accounted(), 3e18);
    }

    function test_rewardsBeforeWithdrawalAreAllocatedFirstAndLaterOnesGoToTheNewHolder() public {
        _deposit();
        _reward(100e18);
        vm.prank(owner);
        vault.withdrawNFT(owner); // ends, then moves the NFT; the reward token is not touched
        assertEq(vault.pending(), 100e18, "what arrived before stays allocated to the same split");
        vault.settle();
        assertEq(vault.claimable(provider), 30e18);
        assertEq(vault.claimable(owner), 70e18);
        vm.prank(provider);
        assertEq(vault.claim(), 30e18, "the provider's allocation survives exit");
        // the next payout goes to whoever holds the NFT now: the owner's wallet, not the vault
        imd.mint(owner, 100e18);
        assertEq(vault.pending(), 0);
        // anything that still lands in the vault is split by the same terms, nothing gets stuck
        _reward(10e18);
        vm.prank(provider);
        assertEq(vault.claim(), 3e18);
        vm.prank(owner);
        assertEq(vault.claim(), 77e18);
    }

    function test_anyOtherTokenLandingHereIsTheOwnersToRescueNotSplit() public {
        _deposit();
        MockERC20 projectToken = new MockERC20();
        projectToken.mint(address(vault), 1000);
        assertEq(vault.pending(), 0, "another token is not a reward");
        vm.prank(provider);
        vm.expectRevert(SeatVault.NothingToClaim.selector);
        vault.claim();
        vm.prank(provider);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.rescueERC20(IERC20(address(projectToken)), provider);
        vm.prank(owner);
        vault.rescueERC20(IERC20(address(projectToken)), owner);
        assertEq(projectToken.balanceOf(owner), 1000);
        assertEq(vault.accounted(), 0, "the reward ledger never saw it");
    }

    function test_twoVaultsAttributeSeparately() public {
        seats.mint(owner, 2049);
        vm.prank(owner);
        SeatVault second = factory.create(provider, operator, 2049, 5000, keccak256("device two"));
        assertEq(factory.count(), 2);
        assertEq(factory.vaults(1), address(second));
        _deposit();
        vm.startPrank(owner);
        seats.approve(address(second), 2049);
        second.deposit();
        vm.stopPrank();
        _reward(100e18);
        imd.mint(address(second), 40e18);
        vm.startPrank(provider);
        assertEq(vault.claim(), 30e18, "seat 2048 at 30%");
        assertEq(second.claim(), 20e18, "seat 2049 at 50%");
        vm.stopPrank();
        assertEq(vault.tokenId(), TOKEN);
        assertEq(second.tokenId(), 2049);
    }

    // ---------------------------------------------------------------- tokens and reentrancy

    function test_reentrancyFromTheRewardTokenIsBlocked() public {
        ReenteringRewardToken hooked = new ReenteringRewardToken();
        SeatVaultFactory f =
            new SeatVaultFactory(IERC721(address(seats)), IERC20(address(hooked)), address(registry), RELAY);
        seats.mint(owner, 5);
        vm.prank(owner);
        SeatVault v = f.create(provider, operator, 5, PROVIDER_BPS, DEVICE);
        vm.startPrank(owner);
        seats.approve(address(v), 5);
        v.deposit();
        vm.stopPrank();
        hooked.mint(address(v), 100e18);
        hooked.arm(v);
        vm.prank(provider);
        assertEq(v.claim(), 30e18);
        assertEq(hooked.blocked(), 2, "claim and settle re-entries were both rejected by the guard");
        assertEq(v.claimable(owner), 70e18);
    }

    function test_recipientTaxTokenCannotShortPayAClaim() public {
        RecipientTaxRewardToken taxed = new RecipientTaxRewardToken();
        SeatVaultFactory f =
            new SeatVaultFactory(IERC721(address(seats)), IERC20(address(taxed)), address(registry), RELAY);
        seats.mint(owner, 6);
        vm.prank(owner);
        SeatVault v = f.create(provider, operator, 6, PROVIDER_BPS, DEVICE);
        vm.startPrank(owner);
        seats.approve(address(v), 6);
        v.deposit();
        vm.stopPrank();
        taxed.setTaxedSender(address(v));
        taxed.mint(address(v), 100e18);
        v.settle();
        vm.prank(provider);
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        v.claim();
        assertEq(v.claimable(provider), 30e18, "allocation intact, nothing left the vault");
    }

    function test_shrinkingTokenDoesNotUnderflowButCanLeaveTheLastClaimantShort() public {
        ShrinkingRewardToken shrinking = new ShrinkingRewardToken();
        SeatVaultFactory f =
            new SeatVaultFactory(IERC721(address(seats)), IERC20(address(shrinking)), address(registry), RELAY);
        seats.mint(owner, 8);
        vm.prank(owner);
        SeatVault v = f.create(provider, operator, 8, PROVIDER_BPS, DEVICE);
        vm.startPrank(owner);
        seats.approve(address(v), 8);
        v.deposit();
        vm.stopPrank();
        shrinking.mint(address(v), 100e18);
        v.settle();
        shrinking.shrink(address(v), 50e18); // balances change outside transfers: unsupported asset behaviour
        v.settle(); // no revert, nothing new to allocate
        assertEq(v.pending(), 0);
        vm.prank(provider);
        assertEq(v.claim(), 30e18, "first claimant is paid");
        vm.prank(owner);
        assertEq(v.claim(), 20e18, "the last claimant takes what is there");
        assertEq(v.claimable(owner), 50e18, "the rest stays allocated, the ledger does not lie");
        assertEq(v.shortfall(), 50e18);
        vm.prank(owner);
        vm.expectRevert(SeatVault.NothingToClaim.selector); // nothing left to pay until the balance recovers
        v.claim();
    }

    function test_rescueOtherNFTsButNeverTheSeat() public {
        _deposit();
        MockERC721 agentTokens = new MockERC721();
        agentTokens.mint(address(vault), 51029); // what another collection might mint to the holder
        vm.prank(provider);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.rescueERC721(IERC721(address(agentTokens)), 51029, provider);
        vm.prank(owner);
        vm.expectRevert(SeatVault.UseWithdraw.selector);
        vault.rescueERC721(IERC721(address(seats)), TOKEN, owner);
        vm.prank(owner);
        vault.rescueERC721(IERC721(address(agentTokens)), 51029, owner);
        assertEq(agentTokens.ownerOf(51029), owner);
        assertEq(seats.ownerOf(TOKEN), address(vault), "the seat stayed");
    }

    function test_factoryPinsTermsAndRejectsBadOnes() public {
        vm.startPrank(owner);
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        factory.create(owner, operator, 1, PROVIDER_BPS, DEVICE); // owner == provider
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        factory.create(provider, operator, 1, 10_001, DEVICE); // > 100%
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        factory.create(provider, operator, 1, PROVIDER_BPS, bytes32(0)); // no device
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        factory.create(provider, address(0), 1, PROVIDER_BPS, DEVICE); // no operator
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        factory.create(provider, owner, 1, PROVIDER_BPS, DEVICE); // operator must not be the owner
        vm.expectRevert(SeatVault.InvalidTerms.selector);
        factory.create(provider, provider, 1, PROVIDER_BPS, DEVICE); // nor the provider
        vm.stopPrank();
        assertEq(address(vault.collection()), address(seats));
        assertEq(address(vault.rewardToken()), address(imd));
        assertEq(vault.registrar(), address(registry));
        assertEq(vault.relayOrigin(), RELAY);
        assertEq(vault.owner(), owner);
        assertEq(vault.providerBps(), PROVIDER_BPS);
    }
}
