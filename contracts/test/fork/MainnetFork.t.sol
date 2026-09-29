// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Mainnet FORK rehearsal against the real IMD seat collection, the real IMD token and the real ERC-8004 registry, with
// the seat's current holder impersonated by the test harness. Read-only RPC; nothing is broadcast. Skips unless both
// MAINNET_RPC_URL and FORK_SEAT (the token id of a seat to rehearse with; its holder is read from the collection) are
// set, so CI and reviewers never touch a network by default. FORK_BLOCK pins the fork to a block for reproducibility.
//   MAINNET_RPC_URL=<mainnet rpc> FORK_SEAT=<token id> forge test --match-contract MainnetFork -vv

import {Test} from "forge-std/Test.sol";
import {SeatVault, SeatVaultFactory} from "../../src/SeatVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IRegistry {
    function register() external returns (uint256);
    function ownerOf(uint256) external view returns (address);
}

contract MainnetFork is Test {
    IERC721 constant SEATS = IERC721(0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D); // IdentityMD seats (verified, no proxy)
    IERC20 constant IMD = IERC20(0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7);
    address constant REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432; // ERC-8004 identity registry (proxy)
    uint256 constant OPERATOR_KEY = 0xA11CE;
    address provider = makeAddr("host");
    bool forked;
    uint256 seat;
    address holder;
    SeatVaultFactory factory;
    SeatVault vault;

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        string memory seatId = vm.envOr("FORK_SEAT", string(""));
        if (bytes(rpc).length == 0 || bytes(seatId).length == 0) return;
        uint256 blockNumber = vm.envOr("FORK_BLOCK", uint256(0));
        if (blockNumber == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blockNumber);
        assertEq(block.chainid, 1, "MAINNET_RPC_URL must point at mainnet");
        seat = vm.parseUint(seatId);
        holder = SEATS.ownerOf(seat); // whoever holds the seat on the fork is the vault's owner in this rehearsal
        assertTrue(holder != address(0));
        factory = new SeatVaultFactory(SEATS, IMD, REGISTRY, "https://api.imd.fun");
        vm.prank(holder);
        vault = factory.create(provider, vm.addr(OPERATOR_KEY), seat, 3000, keccak256("rehearsal device"));
        forked = true;
    }

    function test_depositAndWithdrawRoundTripWithTheRealCollection() public onlyFork {
        vm.startPrank(holder);
        SEATS.approve(address(vault), seat);
        vault.deposit();
        assertEq(SEATS.ownerOf(seat), address(vault));
        assertTrue(vault.held());
        vault.withdrawNFT(holder);
        vm.stopPrank();
        assertEq(SEATS.ownerOf(seat), holder, "the seat comes straight back");
        assertTrue(vault.ended());
    }

    function test_plainTransferInAndWithdrawWithTheRealCollection() public onlyFork {
        vm.startPrank(holder);
        SEATS.transferFrom(holder, address(vault), seat);
        assertEq(SEATS.ownerOf(seat), address(vault));
        assertFalse(vault.held());
        vault.syncHeld();
        assertTrue(vault.held());
        vault.withdrawNFT(holder);
        vm.stopPrank();
        assertEq(SEATS.ownerOf(seat), holder);
    }

    function test_pairingDigestRegistrationRewardsAndExitOnTheFork() public onlyFork {
        vm.startPrank(holder);
        SEATS.approve(address(vault), seat);
        vault.deposit();
        bytes32 digest = vault.approvePairing(
            keccak256("rehearsal nonce"), uint64(vm.getBlockTimestamp() + 600), "https://api.imd.fun"
        );
        vm.stopPrank();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_KEY, digest);
        assertEq(vault.isValidSignature(digest, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
        // registration through the vault against the real registry: whatever it mints lands in the vault
        vm.prank(holder);
        bytes memory result = vault.registerAgent(abi.encodeCall(IRegistry.register, ()));
        uint256 agentId = abi.decode(result, (uint256));
        assertEq(
            IRegistry(REGISTRY).ownerOf(agentId), address(vault), "the real registry minted the agent NFT to the vault"
        );
        emit log_named_uint("agent id minted on the fork", agentId);
        // a reward arrives: the real IMD token's balance of the vault is raised by the harness
        deal(address(IMD), address(vault), 100e18);
        uint256 holderBefore = IMD.balanceOf(holder);
        vm.prank(provider);
        assertEq(vault.claim(IMD), 30e18);
        vm.prank(holder);
        assertEq(vault.claim(IMD), 70e18);
        assertEq(IMD.balanceOf(holder) - holderBefore, 70e18);
        // exit: the seat comes back, the agent NFT can be rescued afterwards
        vm.startPrank(holder);
        vault.withdrawNFT(holder);
        assertEq(SEATS.ownerOf(seat), holder);
        vault.rescueERC721(IERC721(REGISTRY), agentId, holder);
        assertEq(IRegistry(REGISTRY).ownerOf(agentId), holder);
        vm.stopPrank();
        assertEq(
            vault.isValidSignature(digest, abi.encodePacked(r, s, v)),
            bytes4(0xffffffff),
            "nothing validates after exit"
        );
    }

    function test_nobodyElseCanMoveTheSeat() public onlyFork {
        vm.startPrank(holder);
        SEATS.approve(address(vault), seat);
        vault.deposit();
        vm.stopPrank();
        vm.startPrank(provider);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.withdrawNFT(provider);
        vm.expectRevert(SeatVault.NotOwner.selector);
        vault.rescueERC721(SEATS, seat, provider);
        vm.expectRevert(SeatVault.UnsupportedToken.selector);
        vault.claim(IERC20(address(SEATS)));
        vm.expectRevert();
        SEATS.transferFrom(address(vault), provider, seat);
        vm.stopPrank();
        assertEq(SEATS.ownerOf(seat), address(vault));
    }
}
