// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

// Handler-driven invariants over one vault: the reward ledger with an honest reward token, custody against a shadow
// model of where the seat is, the pairing answer tied to custody and expiry, and the two rescue paths. The campaign
// starts with the seat still in the owner's wallet, so both deposit paths (deposit and plain transfer + sync) run.
// Every handler action guards its own preconditions, so `fail_on_revert = true` makes any unexpected revert a
// failure, and the "strangers" action asserts that the calls which must fail do fail.

import {Test} from "forge-std/Test.sol";
import {SeatVault} from "../src/SeatVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {MockERC20} from "./Mocks.sol";
import {MockERC721, MockRegistrar, AliasedRewardToken} from "./VaultMocks.sol";

contract VaultHandler is Test {
    SeatVault public vault;
    MockERC20 public token;
    MockERC20 public other;
    MockERC721 public seats;
    MockERC721 public strays;
    address public owner;
    address public provider;
    address public sink;
    uint256 public constant OPERATOR_KEY = 0x5eed11;
    string public constant RELAY = "https://relay.invalid";

    uint256 public minted;
    uint256 public paidOut;
    uint256 public otherMinted;
    uint256 public strayCount;
    /// @dev Shadow model: where the seat must be after every action.
    address public seatHolder;
    /// @dev The last approval the owner made and a valid operator signature for it.
    bytes32 public lastDigest;
    bytes public lastSignature;
    uint256 public registrations;

    constructor(SeatVault vault_, MockERC20 token_, MockERC721 seats_, address owner_, address provider_) {
        vault = vault_;
        token = token_;
        seats = seats_;
        owner = owner_;
        provider = provider_;
        other = new MockERC20();
        strays = new MockERC721();
        sink = makeAddr("inv-sink");
        seatHolder = owner_;
    }

    // ---------------------------------------------------------------- rewards

    function arrive(uint256 amount) external {
        amount = bound(amount, 1, 1e24);
        token.mint(address(vault), amount);
        minted += amount;
    }

    function settle() external {
        vault.settle();
    }

    function claimAsOwner() external {
        _claim(owner);
    }

    function claimAsProvider() external {
        _claim(provider);
    }

    function otherTokenArrives(uint256 amount) external {
        amount = bound(amount, 1, 1e24);
        other.mint(address(vault), amount);
        otherMinted += amount;
    }

    function rescueOther() external {
        if (other.balanceOf(address(vault)) == 0) return;
        vm.prank(owner);
        vault.rescueERC20(IERC20(address(other)), owner);
    }

    // ---------------------------------------------------------------- custody (every guard reads state before the prank)

    function depositSeat() external {
        uint256 id = vault.tokenId();
        if (seats.ownerOf(id) != owner || vault.held() || vault.ended()) return;
        vm.startPrank(owner);
        seats.approve(address(vault), id);
        vault.deposit();
        vm.stopPrank();
        seatHolder = address(vault);
    }

    function plainTransferIn() external {
        uint256 id = vault.tokenId();
        if (seats.ownerOf(id) != owner) return;
        vm.prank(owner);
        seats.transferFrom(owner, address(vault), id); // no callback: not recorded until sync; after exit never pairable
        seatHolder = address(vault);
    }

    function sync() external {
        uint256 id = vault.tokenId();
        if (vault.ended() || vault.held() || seats.ownerOf(id) != address(vault)) return;
        vm.prank(owner);
        vault.syncHeld();
    }

    function endAsProvider() external {
        if (vault.ended() || !vault.held()) return;
        vm.prank(provider);
        vault.end();
    }

    function endAsOwner() external {
        if (vault.ended()) return;
        vm.prank(owner);
        vault.end();
    }

    function withdraw() external {
        _withdraw(owner);
    }

    function withdrawToSink() external {
        _withdraw(sink);
    }

    function sinkReturnsSeatToOwner() external {
        uint256 id = vault.tokenId();
        if (seats.ownerOf(id) != sink) return;
        vm.prank(sink);
        seats.transferFrom(sink, owner, id);
        seatHolder = owner;
    }

    function strayArrives() external {
        if (strayCount >= 8) return;
        strays.mint(address(vault), ++strayCount);
    }

    function rescueStray(uint256 pick) external {
        if (strayCount == 0) return;
        uint256 id = 1 + (pick % strayCount);
        if (strays.ownerOf(id) != address(vault)) return;
        vm.prank(owner);
        vault.rescueERC721(IERC721(address(strays)), id, owner);
    }

    // ---------------------------------------------------------------- pairing and registration

    function approve(bytes32 nonce, uint256 ttl) external {
        if (!vault.held() || vault.ended()) return;
        uint64 until = uint64(vm.getBlockTimestamp() + bound(ttl, 1, 1 hours));
        vm.prank(owner);
        bytes32 digest = vault.approvePairing(nonce, until, RELAY);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_KEY, digest);
        lastDigest = digest;
        lastSignature = abi.encodePacked(r, s, v);
    }

    function revoke() external {
        vm.prank(owner);
        vault.revokePairing();
    }

    function rotateDevice(bytes32 key) external {
        if (vault.ended() || key == bytes32(0)) return;
        vm.prank(owner);
        vault.setDeviceKey(key);
    }

    function register() external {
        if (!vault.held() || vault.ended()) return;
        bytes memory data =
            abi.encodeWithSelector(vault.REGISTER_SELECTOR(), uint8(0), address(seats), vault.tokenId(), "ipfs://card");
        vm.prank(owner);
        vault.registerAgent(data);
        registrations++;
    }

    function warp(uint256 delta) external {
        vm.warp(vm.getBlockTimestamp() + bound(delta, 1, 2 hours));
    }

    function rescueThroughARewardAliasMustFail() external {
        uint256 balance = token.balanceOf(address(vault));
        address entry = address(AliasedRewardToken(address(token)).entry());
        vm.prank(owner);
        (bool ok,) = address(vault).call(abi.encodeCall(SeatVault.rescueERC20, (IERC20(entry), owner)));
        require(!ok || balance == 0, "a second entry point of the reward token is not a rescue target");
    }

    // ---------------------------------------------------------------- strangers: calls that must fail (low-level, so a
    // wrongly succeeding call reverts the handler and fails the campaign)

    function strangersCannotMoveTheSeat() external {
        uint256 id = vault.tokenId();
        address[2] memory callers = [provider, sink];
        for (uint256 i; i < 2; ++i) {
            vm.prank(callers[i]);
            (bool ok,) = address(vault).call(abi.encodeCall(SeatVault.withdrawNFT, (callers[i])));
            require(!ok, "only the owner withdraws");
            vm.prank(callers[i]);
            (ok,) =
                address(vault).call(abi.encodeCall(SeatVault.rescueERC721, (IERC721(address(seats)), id, callers[i])));
            require(!ok, "only the owner rescues, and never the seat");
            vm.prank(callers[i]);
            (ok,) = address(vault).call(abi.encodeCall(SeatVault.rescueERC20, (IERC20(address(other)), callers[i])));
            require(!ok, "only the owner rescues tokens");
            vm.prank(callers[i]);
            (ok,) = address(seats).call(abi.encodeCall(IERC721.transferFrom, (address(vault), callers[i], id)));
            require(!ok, "the vault hands out no approvals");
        }
        vm.prank(owner);
        (bool ok2,) = address(vault).call(abi.encodeCall(SeatVault.rescueERC721, (IERC721(address(seats)), id, owner)));
        require(!ok2, "the seat leaves only through withdrawNFT");
        vm.prank(owner);
        (ok2,) = address(vault).call(abi.encodeCall(SeatVault.rescueERC20, (IERC20(address(seats)), owner)));
        require(!ok2, "the seat collection is never a token rescue target");
        vm.prank(owner);
        (ok2,) = address(vault).call(abi.encodeCall(SeatVault.rescueERC20, (token, owner)));
        require(!ok2, "rewards leave only through claim");
    }

    // ---------------------------------------------------------------- internals

    function _withdraw(address to) internal {
        uint256 id = vault.tokenId();
        if (seats.ownerOf(id) != address(vault)) return;
        vm.prank(owner);
        vault.withdrawNFT(to);
        seatHolder = to;
    }

    function _claim(address party) internal {
        vault.settle();
        if (vault.claimable(party) == 0) return;
        vm.prank(party);
        paidOut += vault.claim();
    }
}

contract SeatVaultInvariants is Test {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    SeatVault internal vault;
    MockERC20 internal token;
    MockERC721 internal seats;
    VaultHandler internal handler;
    address internal owner = makeAddr("inv-owner");
    address internal provider = makeAddr("inv-provider");

    function setUp() public {
        vm.warp(1_800_000_000);
        seats = new MockERC721();
        token = new AliasedRewardToken(); // the reward token has a second entry point the campaign must not be able to use
        MockRegistrar registry = new MockRegistrar();
        seats.mint(owner, 1);
        vault = new SeatVault(
            owner,
            provider,
            vm.addr(0x5eed11),
            seats,
            1,
            token,
            3000,
            keccak256("inv-device"),
            address(registry),
            "https://relay.invalid"
        );
        handler = new VaultHandler(vault, token, seats, owner, provider);
        targetContract(address(handler));
    }

    /// @dev Deterministic regression: the handler's plain-return path must actually run (it once consumed its own
    /// prank on a getter and silently reverted every time).
    function test_handlerRedepositReturnsTheSeatAfterExit() public {
        handler.depositSeat();
        handler.withdraw();
        assertEq(seats.ownerOf(1), owner);
        handler.plainTransferIn();
        assertEq(seats.ownerOf(1), address(vault), "the plain return landed");
        handler.withdraw();
        assertEq(seats.ownerOf(1), owner, "and the seat is recoverable again");
    }

    /// @dev Deterministic regression: every other handler action does something on a fresh vault.
    function test_handlerActionsRun() public {
        handler.plainTransferIn();
        assertFalse(vault.held());
        handler.endAsProvider(); // not recorded yet: nothing happens
        assertFalse(vault.ended());
        handler.sync();
        assertTrue(vault.held(), "the plain-transferred seat was recorded");
        handler.approve(keccak256("n"), 600);
        assertEq(vault.isValidSignature(handler.lastDigest(), handler.lastSignature()), MAGIC);
        handler.register();
        assertEq(handler.registrations(), 1);
        handler.strayArrives();
        assertEq(handler.strays().ownerOf(1), address(vault));
        handler.rescueStray(0);
        assertEq(handler.strays().ownerOf(1), owner);
        handler.otherTokenArrives(5);
        handler.rescueOther();
        assertEq(handler.other().balanceOf(owner), 5);
        handler.strangersCannotMoveTheSeat();
        handler.arrive(10);
        handler.rescueThroughARewardAliasMustFail();
        assertEq(token.balanceOf(address(vault)), 10, "the alias rescue moved nothing");
        handler.warp(2 hours);
        assertEq(vault.isValidSignature(handler.lastDigest(), handler.lastSignature()), bytes4(0xffffffff));
        handler.withdrawToSink();
        assertEq(seats.ownerOf(1), handler.sink());
        handler.sinkReturnsSeatToOwner();
        handler.plainTransferIn();
        handler.sync(); // ended: nothing to do
        assertFalse(vault.held(), "a plain return after exit is never recorded as held");
    }

    // ---------------------------------------------------------------- reward ledger

    function invariant_allocationsEqualClaimables() public view {
        assertEq(vault.accounted(), vault.claimable(owner) + vault.claimable(provider));
    }

    function invariant_vaultBacksItsAllocations() public view {
        assertGe(token.balanceOf(address(vault)), vault.accounted());
        assertEq(vault.shortfall(), 0);
    }

    function invariant_nothingMintedOrLost() public view {
        assertEq(token.balanceOf(address(vault)) + token.balanceOf(owner) + token.balanceOf(provider), handler.minted());
        assertEq(token.balanceOf(owner) + token.balanceOf(provider), handler.paidOut());
        assertEq(vault.pending() + vault.accounted(), token.balanceOf(address(vault)));
    }

    function invariant_otherTokensNeverEnterTheSplit() public view {
        MockERC20 other = handler.other();
        assertEq(other.balanceOf(provider), 0, "the provider never receives a token that is not the reward");
        assertEq(other.balanceOf(address(vault)) + other.balanceOf(owner), handler.otherMinted());
    }

    // ---------------------------------------------------------------- custody

    function invariant_theSeatIsWhereTheModelSaysAndNowhereElse() public view {
        assertEq(seats.ownerOf(1), handler.seatHolder());
    }

    function invariant_heldMeansTheVaultOwnsTheSeat() public view {
        if (vault.held()) assertEq(seats.ownerOf(1), address(vault));
    }

    function invariant_straysStayWithTheVaultOrTheOwner() public view {
        MockERC721 strays = handler.strays();
        for (uint256 id = 1; id <= handler.strayCount(); ++id) {
            address holder = strays.ownerOf(id);
            assertTrue(holder == address(vault) || holder == owner, "a stray goes only to the owner");
        }
    }

    // ---------------------------------------------------------------- pairing

    function invariant_anApprovalOnlyExistsWhileHeldAndOpen() public view {
        if (vault.approvedUntil() != 0) {
            assertTrue(vault.held() && !vault.ended());
            assertEq(seats.ownerOf(1), address(vault));
        }
    }

    function invariant_aValidAnswerImpliesCustodyAndAnUnexpiredApproval() public view {
        bytes32 digest = handler.lastDigest();
        if (digest == bytes32(0)) return;
        if (vault.isValidSignature(digest, handler.lastSignature()) == MAGIC) {
            assertTrue(vault.held() && !vault.ended());
            assertEq(seats.ownerOf(1), address(vault));
            assertEq(vault.approvedDigest(), digest);
            assertLe(vm.getBlockTimestamp(), vault.approvedUntil());
        }
    }
}
