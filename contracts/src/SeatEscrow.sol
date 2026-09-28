// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SeatEscrow: a rental with a security deposit, for one hosted IMD seat per agreement.
/// @notice The owner keeps the NFT and receives its rewards in the owner's own wallet. The provider runs the
/// worker for a daily fee that accrues by the clock from activation until either party ends. The owner's deposit
/// is the provider's only enforced protection: the provider may draw unpaid fee from it at any time, and the owner
/// takes back whatever it still holds beyond unpaid fee the moment the agreement ends. The reward share promised
/// in the terms is paid by the owner per payout, on-chain and referenced, but the contract does not enforce it.
/// No admin, no upgrade path, no sweep.
contract SeatEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DAY = 24 hours;
    /// @dev Bound on every stored amount and rate, so no sum or product in this contract can overflow.
    uint256 public constant MAX_AMOUNT = type(uint128).max;

    enum Status {
        Proposed,
        Active,
        Ended
    }

    /// @dev Immutable terms. The full off-chain document (seat, wallet, service) hashes into `docHash`; `termsHash`
    /// binds that document to these numbers, this contract and this chain.
    struct Terms {
        address owner;
        address provider;
        IERC20 asset;
        uint256 dailyFee;
        uint16 shareBps;
        uint256 requiredDeposit;
        bytes32 termsHash;
    }

    struct State {
        Status status;
        bool ownerApproved;
        bool providerApproved;
        uint64 startedAt;
        uint64 endedAt;
        uint256 reserve;
        uint256 feeCredited;
        uint256 providerClaim;
    }

    struct Agreement {
        Terms terms;
        State state;
    }

    uint256 public agreementCount;
    mapping(uint256 => Agreement) internal agreements;

    event Proposed(
        uint256 indexed id,
        address indexed owner,
        address indexed provider,
        address asset,
        uint256 dailyFee,
        uint16 shareBps,
        uint256 requiredDeposit,
        bytes32 docHash,
        bytes32 termsHash
    );
    event Approved(uint256 indexed id, address indexed by);
    event Activated(uint256 indexed id, uint64 startedAt);
    event Deposited(uint256 indexed id, uint256 amount, uint256 reserve);
    event FeePaid(uint256 indexed id, uint256 amount);
    event SharePaid(uint256 indexed id, uint256 amount, bytes32 indexed payoutRef);
    event Drawn(uint256 indexed id, uint256 amount, uint256 reserve);
    event Claimed(uint256 indexed id, uint256 amount);
    event Ended(uint256 indexed id, address indexed by, uint64 endedAt);
    event Refunded(uint256 indexed id, uint256 amount, uint256 reserve);

    error NotOwner();
    error NotProvider();
    error NotParty();
    error BadStatus();
    error InvalidTerms();
    error TermsMismatch();
    error AlreadyApproved();
    error NotApproved();
    error DepositRequired();
    error AmountZero();
    error AmountTooLarge();
    error NothingDue();
    error ExceedsDue();
    error NothingToClaim();
    error NothingRefundable();
    error UnsupportedToken();

    // ---------------------------------------------------------------- setup

    /// @notice Either party proposes the terms; the proposer counts as having approved them.
    /// @param dailyFee Fee per 24 h of agreement time, accrued per second. Zero makes a pure revenue-share listing.
    /// @param shareBps Reward share the owner promises to pass on, in basis points. Informational: not enforced.
    /// @param requiredDeposit Reserve the owner must hold before activation; at least one day of fee.
    /// @param docHash Hash of the full off-chain terms document.
    function propose(
        address owner,
        address provider,
        IERC20 asset,
        uint256 dailyFee,
        uint16 shareBps,
        uint256 requiredDeposit,
        bytes32 docHash
    ) external returns (uint256 id) {
        if (msg.sender != owner && msg.sender != provider) revert NotParty();
        if (owner == provider || owner == address(0) || provider == address(0) || address(asset) == address(0)) {
            revert InvalidTerms();
        }
        if (dailyFee > MAX_AMOUNT || requiredDeposit > MAX_AMOUNT || requiredDeposit < dailyFee || shareBps > 10_000) {
            revert InvalidTerms();
        }
        if (docHash == bytes32(0)) revert InvalidTerms();
        bytes32 termsHash = termsDigest(owner, provider, asset, dailyFee, shareBps, requiredDeposit, docHash);
        id = ++agreementCount;
        Agreement storage a = agreements[id];
        a.terms = Terms(owner, provider, asset, dailyFee, shareBps, requiredDeposit, termsHash);
        if (msg.sender == owner) a.state.ownerApproved = true;
        else a.state.providerApproved = true;
        emit Proposed(id, owner, provider, address(asset), dailyFee, shareBps, requiredDeposit, docHash, termsHash);
        emit Approved(id, msg.sender);
    }

    /// @notice The counterparty approves by presenting the digest of the exact terms it reviewed.
    function approve(uint256 id, bytes32 termsHash) external {
        Agreement storage a = agreements[id];
        if (a.state.status != Status.Proposed) revert BadStatus();
        if (msg.sender != a.terms.owner && msg.sender != a.terms.provider) revert NotParty();
        if (termsHash != a.terms.termsHash) revert TermsMismatch();
        if (msg.sender == a.terms.owner) {
            if (a.state.ownerApproved) revert AlreadyApproved();
            a.state.ownerApproved = true;
        } else {
            if (a.state.providerApproved) revert AlreadyApproved();
            a.state.providerApproved = true;
        }
        emit Approved(id, msg.sender);
    }

    /// @notice Owner funds or tops up the deposit. Allowed before activation and while active; pays nobody by itself.
    function deposit(uint256 id, uint256 amount) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.owner) revert NotOwner();
        if (a.state.status == Status.Ended) revert BadStatus();
        _checkAmount(amount);
        if (a.state.reserve + amount > MAX_AMOUNT) revert AmountTooLarge();
        _pullExact(a.terms.asset, msg.sender, amount);
        a.state.reserve += amount;
        emit Deposited(id, amount, a.state.reserve);
    }

    /// @notice Owner starts the clock once both approved and the deposit is funded. Only the owner can start billing.
    function activate(uint256 id) external {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.owner) revert NotOwner();
        if (a.state.status != Status.Proposed) revert BadStatus();
        if (!a.state.ownerApproved || !a.state.providerApproved) revert NotApproved();
        if (a.state.reserve < a.terms.requiredDeposit) revert DepositRequired();
        a.state.status = Status.Active;
        // casting to uint64 is safe: block timestamps stay below 2^64 for the next 500 billion years
        // forge-lint: disable-next-line(unsafe-typecast)
        a.state.startedAt = uint64(block.timestamp);
        emit Activated(id, a.state.startedAt);
    }

    // ---------------------------------------------------------------- money

    /// @notice Owner pays unpaid fee with fresh funds, leaving the deposit intact.
    function payFee(uint256 id, uint256 amount) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.owner) revert NotOwner();
        if (a.state.startedAt == 0) revert BadStatus();
        _checkAmount(amount);
        uint256 due = feeOwed(id);
        if (due == 0) revert NothingDue();
        if (amount > due) revert ExceedsDue();
        if (a.state.providerClaim + amount > MAX_AMOUNT) revert AmountTooLarge();
        _pullExact(a.terms.asset, msg.sender, amount);
        a.state.feeCredited += amount;
        a.state.providerClaim += amount;
        emit FeePaid(id, amount);
    }

    /// @notice Owner passes on a reward share, referencing the payout it belongs to (for example the hash of the
    /// reward transaction). Voluntary: never counted against fee, never drawn from the deposit.
    function payShare(uint256 id, uint256 amount, bytes32 payoutRef) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.owner) revert NotOwner();
        if (a.state.startedAt == 0) revert BadStatus();
        _checkAmount(amount);
        if (a.state.providerClaim + amount > MAX_AMOUNT) revert AmountTooLarge();
        _pullExact(a.terms.asset, msg.sender, amount);
        a.state.providerClaim += amount;
        emit SharePaid(id, amount, payoutRef);
    }

    /// @notice Provider takes unpaid fee out of the deposit, capped by what the deposit holds.
    function draw(uint256 id) external nonReentrant returns (uint256 amount) {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.provider) revert NotProvider();
        if (a.state.startedAt == 0) revert BadStatus();
        uint256 due = feeOwed(id);
        amount = due < a.state.reserve ? due : a.state.reserve;
        if (amount == 0) revert NothingDue();
        if (a.state.providerClaim + amount > MAX_AMOUNT) revert AmountTooLarge(); // claim first, then draw
        a.state.reserve -= amount;
        a.state.feeCredited += amount;
        a.state.providerClaim += amount;
        emit Drawn(id, amount, a.state.reserve);
    }

    /// @notice Provider withdraws everything funded so far. Works after exit too.
    function claim(uint256 id) external nonReentrant returns (uint256 amount) {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.provider) revert NotProvider();
        amount = a.state.providerClaim;
        if (amount == 0) revert NothingToClaim();
        a.state.providerClaim = 0;
        _pushExact(a.terms.asset, a.terms.provider, amount);
        emit Claimed(id, amount);
    }

    // ---------------------------------------------------------------- exit

    /// @notice Either party ends the agreement. The fee stops accruing now; the first exit wins.
    function end(uint256 id) external {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.owner && msg.sender != a.terms.provider) revert NotParty();
        if (a.state.status == Status.Ended) revert BadStatus();
        a.state.status = Status.Ended;
        // forge-lint: disable-next-line(unsafe-typecast)
        a.state.endedAt = uint64(block.timestamp);
        emit Ended(id, msg.sender, a.state.endedAt);
    }

    /// @notice Owner takes back the deposit beyond any unpaid fee, immediately after exit. Unpaid fee stays
    /// reserved for the provider to draw.
    function refund(uint256 id) external nonReentrant returns (uint256 amount) {
        Agreement storage a = agreements[id];
        if (msg.sender != a.terms.owner) revert NotOwner();
        if (a.state.status != Status.Ended) revert BadStatus();
        amount = refundable(id);
        if (amount == 0) revert NothingRefundable();
        a.state.reserve -= amount;
        _pushExact(a.terms.asset, a.terms.owner, amount);
        emit Refunded(id, amount, a.state.reserve);
    }

    // ---------------------------------------------------------------- views

    function termsOf(uint256 id) external view returns (Terms memory) {
        return agreements[id].terms;
    }

    function stateOf(uint256 id) external view returns (State memory) {
        return agreements[id].state;
    }

    /// @notice The digest a counterparty presents to `approve`. Recompute it from the displayed terms; never trust
    /// a bare hash.
    function termsDigest(
        address owner,
        address provider,
        IERC20 asset,
        uint256 dailyFee,
        uint16 shareBps,
        uint256 requiredDeposit,
        bytes32 docHash
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid, address(this), owner, provider, asset, dailyFee, shareBps, requiredDeposit, docHash
            )
        );
    }

    /// @notice Fee accrued by the clock from activation until now or until exit, rounded down.
    function feeAccrued(uint256 id) public view returns (uint256) {
        Agreement storage a = agreements[id];
        if (a.state.startedAt == 0) return 0;
        uint256 until = a.state.status == Status.Ended ? a.state.endedAt : block.timestamp;
        return (a.terms.dailyFee * (until - a.state.startedAt)) / DAY;
    }

    /// @notice Accrued fee not yet paid or drawn.
    function feeOwed(uint256 id) public view returns (uint256) {
        return feeAccrued(id) - agreements[id].state.feeCredited;
    }

    /// @notice Deposit beyond unpaid fee: what `refund` releases once the agreement has ended.
    function refundable(uint256 id) public view returns (uint256) {
        uint256 reserve = agreements[id].state.reserve;
        uint256 due = feeOwed(id);
        return reserve > due ? reserve - due : 0;
    }

    /// @notice Unpaid fee the deposit does not cover: the provider's exposure, and the number a host's pause rule
    /// should watch.
    function unsecured(uint256 id) external view returns (uint256) {
        uint256 reserve = agreements[id].state.reserve;
        uint256 due = feeOwed(id);
        return due > reserve ? due - reserve : 0;
    }

    // ---------------------------------------------------------------- internals

    function _checkAmount(uint256 amount) internal pure {
        if (amount == 0) revert AmountZero();
        if (amount > MAX_AMOUNT) revert AmountTooLarge();
    }

    /// @dev Pulls exactly `amount`; tokens whose transfers are inexact are not supported.
    function _pullExact(IERC20 asset, address from, uint256 amount) internal {
        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        if (asset.balanceOf(address(this)) - before != amount) revert UnsupportedToken();
    }

    /// @dev Sends exactly `amount`: this contract's balance must fall by `amount` (so a token that taxes the sender
    /// can never spend a deposit backing another agreement) and the recipient's must rise by `amount` (so a claim
    /// or refund is never recorded as paid while delivering less).
    function _pushExact(IERC20 asset, address to, uint256 amount) internal {
        uint256 before = asset.balanceOf(address(this));
        uint256 toBefore = asset.balanceOf(to);
        asset.safeTransfer(to, amount);
        if (before - asset.balanceOf(address(this)) != amount || asset.balanceOf(to) - toBefore != amount) {
            revert UnsupportedToken();
        }
    }
}
