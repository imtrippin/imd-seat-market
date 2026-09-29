// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SeatVault: holds exactly one IMD seat NFT for one hosting agreement, so that rewards paid to the NFT's
/// holder arrive here and are split by immutable terms.
/// @notice Experimental, local prototype. What this vault enforces: the split of every reward-token transfer that
/// actually reaches it, and the owner's right to take the NFT back without the provider, at any time, even after
/// the agreement ended, even if the NFT arrived by a plain transfer, and without any call to the reward token.
/// What it does not do: judge service, attribute rewards to jobs or periods, tell a misdirected transfer of the
/// reward token from a reward (every positive balance change of it is shared), or revoke a device that IMD already
/// enrolled (moving the NFT out is what makes that device stale on IMD's side). There is no fee and no collateral
/// deposit: `deposit()` moves the seat NFT in. Only the pinned reward token is ever settled or claimed; anything
/// else that lands here (another collection's NFT, another ERC-20) is the owner's to take back.
///
/// Pairing authority. IMD pairs a device to a seat by verifying an EIP-712 `WorkerAuthorization` signature from
/// the seat holder; for a contract holder it calls `isValidSignature(digest, signature)` (ERC-1271). This vault
/// keeps a single active approval: the digest the owner approved on-chain for the agreed device key and relay,
/// valid until its expiry, on the chain it was approved on. It answers valid only for that digest, signed by the
/// agreed operator key or the owner, while the NFT is held and the agreement is open. A new approval replaces the
/// old one; changing the device key, revoking, ending or withdrawing clears it. The operator key can do nothing
/// else, and must be a different key from the owner's and the provider's.
contract SeatVault is IERC1271, IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 private constant ERC1271_INVALID = 0xffffffff;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("IdentityMD Worker");
    bytes32 private constant VERSION_HASH = keccak256("2");
    bytes32 private constant WORKER_AUTHORIZATION_TYPEHASH = keccak256(
        "WorkerAuthorization(bytes32 deviceKey,address wallet,uint256 tokenId,bytes32 nonce,uint64 expiresAt,string relayOrigin)"
    );
    uint256 public constant MAX_PAIRING_WINDOW = 1 hours;
    /// @dev IMD's registrar (`Adapter8004`, verified source read 2026-09-29) registers a seat's ERC-8004 agent with
    /// `register(uint8 standard, address tokenContract, uint256 tokenId, string agentURI)`, optionally with metadata
    /// entries; `GET /agents/register-intent` returns exactly that calldata. Selectors 0xb68ca002 and 0x1fd8046a.
    bytes4 public constant REGISTER_SELECTOR = bytes4(keccak256("register(uint8,address,uint256,string)"));
    bytes4 public constant REGISTER_META_SELECTOR =
        bytes4(keccak256("register(uint8,address,uint256,string,(string,bytes)[])"));
    uint256 public constant BPS = 10_000;

    address public immutable owner;
    address public immutable provider;
    address public immutable operator;
    IERC721 public immutable collection;
    uint256 public immutable tokenId;
    IERC20 public immutable rewardToken;
    uint16 public immutable providerBps;
    address public immutable registrar;
    bytes32 public immutable relayOriginHash;
    string public relayOrigin;

    bytes32 public deviceKey;
    bool public held;
    bool public ended;
    uint64 public endedAt;
    /// @dev The single active pairing approval.
    bytes32 public approvedDigest;
    uint64 public approvedUntil;
    uint256 public approvedChain;
    /// @dev Reward-token balance already allocated to the two parties (still inside the vault until claimed).
    uint256 public accounted;
    mapping(address => uint256) public claimable;

    event NFTDeposited(address indexed from);
    event NFTSynced();
    event NFTWithdrawn(address indexed to);
    event DeviceKeySet(bytes32 deviceKey);
    event PairingApproved(bytes32 indexed digest, bytes32 deviceKey, bytes32 nonce, uint64 expiresAt);
    event PairingCleared(bytes32 indexed digest);
    event Settled(uint256 received, uint256 ownerShare, uint256 providerShare);
    event Claimed(address indexed party, uint256 amount);
    event Ended(address indexed by, uint64 endedAt);
    event AgentRegistered(uint256 indexed agentId, bytes data);

    error NotOwner();
    error NotParty();
    error InvalidTerms();
    error WrongToken();
    error AlreadyHeld();
    error NotHeld();
    error AlreadyEnded();
    error NotPairable();
    error WrongRelay();
    error BadExpiry();
    error NothingToClaim();
    error UseWithdraw();
    error RegistryCallFailed();
    error UnsupportedToken();
    error NotARegistration();
    error ZeroAddress();

    constructor(
        address owner_,
        address provider_,
        address operator_,
        IERC721 collection_,
        uint256 tokenId_,
        IERC20 rewardToken_,
        uint16 providerBps_,
        bytes32 deviceKey_,
        address registrar_,
        string memory relayOrigin_
    ) {
        if (
            owner_ == address(0) || provider_ == address(0) || operator_ == address(0) || owner_ == provider_
                || operator_ == owner_ || operator_ == provider_ || address(collection_) == address(0)
                || address(rewardToken_) == address(0) || registrar_ == address(0) || registrar_ == address(collection_)
                || registrar_ == address(rewardToken_) || registrar_.code.length == 0 || providerBps_ > BPS
                || deviceKey_ == bytes32(0) || bytes(relayOrigin_).length == 0
        ) revert InvalidTerms();
        owner = owner_;
        provider = provider_;
        operator = operator_;
        collection = collection_;
        tokenId = tokenId_;
        rewardToken = rewardToken_;
        providerBps = providerBps_;
        deviceKey = deviceKey_;
        registrar = registrar_;
        relayOrigin = relayOrigin_;
        relayOriginHash = keccak256(bytes(relayOrigin_));
    }

    // ---------------------------------------------------------------- custody

    /// @notice Pulls the seat NFT from the owner (needs an ERC-721 approval to this vault first).
    function deposit() external {
        if (msg.sender != owner) revert NotOwner();
        collection.safeTransferFrom(owner, address(this), tokenId);
    }

    /// @notice The seat NFT is accepted only from the owner, only once, only before exit. Any other collection's
    /// token is accepted and can be rescued by the owner later (another collection may safe-mint one here); no
    /// event is emitted for it, since anyone could call this hook directly and the collection's own logs are the
    /// record.
    function onERC721Received(address, address from, uint256 id, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(collection)) return IERC721Receiver.onERC721Received.selector;
        if (id != tokenId) revert WrongToken();
        if (from != owner) revert NotOwner();
        if (held) revert AlreadyHeld();
        if (ended) revert AlreadyEnded();
        held = true;
        emit NFTDeposited(from);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice If the seat arrived by a plain `transferFrom` (no callback), the owner records it here so pairing
    /// can be approved. Not needed for withdrawal, which looks at actual ownership.
    function syncHeld() external {
        if (msg.sender != owner) revert NotOwner();
        if (ended) revert AlreadyEnded();
        if (held) revert AlreadyHeld();
        if (collection.ownerOf(tokenId) != address(this)) revert NotHeld();
        held = true;
        emit NFTSynced();
    }

    /// @notice The owner takes the seat back whenever this vault actually holds it: before or after the agreement
    /// ended, whether it arrived by deposit or by plain transfer, without the provider. It makes no call to the
    /// reward token, so nothing about that asset can delay the seat's return; rewards already in the vault stay
    /// allocated to the same immutable split and anyone can settle them before or after. Ends the agreement and
    /// clears any pairing approval.
    function withdrawNFT(address to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        if (collection.ownerOf(tokenId) != address(this)) revert NotHeld();
        if (!ended) _end();
        held = false;
        _clearApproval();
        collection.safeTransferFrom(address(this), to, tokenId);
        emit NFTWithdrawn(to);
    }

    /// @notice Either party ends the agreement: no new pairing can be approved or validated. The NFT stays until
    /// the owner withdraws it; allocations stay claimable. The provider can end only once the seat is recorded as
    /// held (after `deposit()` or `syncHeld()`), so it cannot kill a vault before the owner has started it, on
    /// either deposit path.
    function end() external {
        if (msg.sender != owner && msg.sender != provider) revert NotParty();
        if (msg.sender == provider && !held) revert NotHeld();
        if (ended) revert AlreadyEnded();
        _end();
        _clearApproval();
    }

    // ---------------------------------------------------------------- pairing (ERC-1271)

    /// @notice The owner may point the agreement at a replacement device of the same provider. Any pairing
    /// approved for the previous device is cleared.
    function setDeviceKey(bytes32 deviceKey_) external {
        if (msg.sender != owner) revert NotOwner();
        if (ended) revert AlreadyEnded();
        if (deviceKey_ == bytes32(0)) revert InvalidTerms();
        deviceKey = deviceKey_;
        _clearApproval();
        emit DeviceKeySet(deviceKey_);
    }

    /// @notice Owner approves one pairing attempt, replacing any earlier approval: the exact WorkerAuthorization
    /// digest for the agreed device, this vault as wallet, this token, IMD's nonce and the agreed relay, valid until
    /// `expiresAt` (at most one hour). The nonce comes from IMD's pairing response; this transaction must be mined
    /// before the host completes the pairing, and inside IMD's own pairing-code lifetime.
    function approvePairing(bytes32 nonce, uint64 expiresAt, string calldata relayOrigin_)
        external
        returns (bytes32 digest)
    {
        if (msg.sender != owner) revert NotOwner();
        if (!held || ended) revert NotPairable();
        if (keccak256(bytes(relayOrigin_)) != relayOriginHash) revert WrongRelay();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_PAIRING_WINDOW) revert BadExpiry();
        digest = workerAuthorizationDigest(deviceKey, nonce, expiresAt);
        _clearApproval(); // the replaced approval is announced as cleared, like every other path that drops one
        approvedDigest = digest;
        approvedUntil = expiresAt;
        approvedChain = block.chainid;
        emit PairingApproved(digest, deviceKey, nonce, expiresAt);
    }

    /// @notice Clears the active approval. Does not touch a device IMD already enrolled.
    function revokePairing() external {
        if (msg.sender != owner) revert NotOwner();
        _clearApproval();
    }

    /// @notice ERC-1271. Valid only for the active, unexpired approval, on the chain it was approved on, signed by
    /// the operator key or the owner, while the NFT is held and the agreement is open. Never reverts.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (!held || ended) return ERC1271_INVALID;
        if (hash != approvedDigest || approvedUntil == 0) return ERC1271_INVALID;
        if (block.timestamp > approvedUntil || approvedChain != block.chainid) return ERC1271_INVALID;
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err != ECDSA.RecoverError.NoError || signer == address(0)) return ERC1271_INVALID;
        if (signer != operator && signer != owner) return ERC1271_INVALID;
        return ERC1271_MAGIC;
    }

    /// @notice The EIP-712 digest IMD verifies: domain `IdentityMD Worker` v2 on this chain with the NFT contract as
    /// verifying contract; message with this vault as `wallet` and this token.
    function workerAuthorizationDigest(bytes32 deviceKey_, bytes32 nonce, uint64 expiresAt)
        public
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, collection));
        bytes32 structHash = keccak256(
            abi.encode(
                WORKER_AUTHORIZATION_TYPEHASH, deviceKey_, address(this), tokenId, nonce, expiresAt, relayOriginHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// @notice The agent registration IMD asks the seat holder to send (`GET /agents/register-intent` returns the
    /// calldata: `register(0, collection, tokenId, agentURI)` to IMD's registrar). Owner-only, while the seat is
    /// held and the agreement is open, to the pinned registrar, only its two `register` functions, and only for
    /// this vault's own seat as an ERC-721 (`standard` 0). Anything else (URI or metadata updates, wallet changes,
    /// approvals) is refused, so calldata proposed by a third party cannot do more than register this seat.
    /// That is the whole guarantee. The registrar is an external dependency behind an upgradeable proxy: a new
    /// implementation may reject these selectors, accept them with different behaviour, or accept them through a
    /// fallback, and this function can only require the call to succeed and to return one word, the agent id it
    /// records. What a registration means under the implementation reviewed on 2026-09-29 (the agent NFT stays
    /// with the registrar, control of the agent follows the seat's owner, no ETH fee) is that implementation's
    /// behaviour, not something enforced here; compare the live implementation with the reviewed one before use
    /// and check the agent after the receipt. IMD's off-chain bind (`POST /agents/bind`) is a separate step.
    function registerAgent(bytes calldata data) external nonReentrant returns (uint256 agentId) {
        if (msg.sender != owner) revert NotOwner();
        if (ended) revert AlreadyEnded();
        if (!held) revert NotHeld();
        if (data.length < 4) revert InvalidTerms();
        bytes4 selector = bytes4(data[:4]);
        if (selector != REGISTER_SELECTOR && selector != REGISTER_META_SELECTOR) revert NotARegistration();
        if (data.length < 4 + 3 * 32) revert InvalidTerms();
        (uint8 standard, address tokenContract, uint256 boundTokenId) = abi.decode(data[4:], (uint8, address, uint256));
        if (standard != 0 || tokenContract != address(collection) || boundTokenId != tokenId) revert WrongToken();
        (bool ok, bytes memory result) = registrar.call(data);
        if (!ok || result.length != 32) revert RegistryCallFailed();
        agentId = abi.decode(result, (uint256));
        if (agentId == 0) revert RegistryCallFailed(); // ERC-8004 agent ids start at 1; a zero word is no registration
        emit AgentRegistered(agentId, data);
    }

    // ---------------------------------------------------------------- rewards

    /// @notice Allocates every unit of the reward token that arrived since the last settlement, whatever its
    /// source: the owner gets the floor of its share, the provider the remainder, rounding once per settlement.
    /// Anyone may call it; claims call it first.
    function settle() external nonReentrant {
        _settle(rewardToken.balanceOf(address(this)));
    }

    /// @notice A party takes its allocation of the reward token. Rewards that arrived but were not yet settled are
    /// settled first, so nothing can be claimed past an incoming transfer. If the balance fell outside transfers
    /// (an unsupported asset), the claim pays what is there and keeps the rest allocated.
    function claim() external nonReentrant returns (uint256 amount) {
        if (msg.sender != owner && msg.sender != provider) revert NotParty();
        uint256 balance = rewardToken.balanceOf(address(this));
        _settle(balance);
        amount = claimable[msg.sender];
        if (amount > balance) amount = balance;
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] -= amount;
        accounted -= amount;
        _pushExact(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice Unsettled reward-token balance: what the next settlement would split.
    function pending() external view returns (uint256) {
        uint256 balance = rewardToken.balanceOf(address(this));
        return balance > accounted ? balance - accounted : 0;
    }

    /// @notice How far the reward token's actual balance falls short of what is allocated (0 for a well-behaved
    /// token).
    function shortfall() external view returns (uint256) {
        uint256 balance = rewardToken.balanceOf(address(this));
        return accounted > balance ? accounted - balance : 0;
    }

    /// @notice Moves an NFT that is not the designated seat (another collection's token, another token of the seat
    /// collection, or a mistake) to `to`. The reward token and the registrar are never rescue targets, and a rescue
    /// that would change the reward balance or move the seat is refused (see `_rescueCheck`).
    function rescueERC721(IERC721 other, uint256 id, address to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        if (address(other) == address(collection) && id == tokenId) revert UseWithdraw();
        if (address(other) == address(rewardToken) || address(other) == registrar) revert UnsupportedToken();
        (uint256 rewardBefore, bool seatBefore) = _rescueSnapshot();
        other.safeTransferFrom(address(this), to, id);
        _rescueCheck(rewardBefore, seatBefore);
    }

    /// @notice Moves the vault's whole balance of an ERC-20 that is not the reward token to `to`: such a token is
    /// never split, so it is the owner's to take back. The seat collection and the registrar are refused as well
    /// (an ERC-721 with a legacy `transfer(address,uint256)` would move a token by id), and a rescue that would
    /// change the reward balance or move the seat is refused (see `_rescueCheck`).
    function rescueERC20(IERC20 other, address to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        if (
            address(other) == address(rewardToken) || address(other) == address(collection)
                || address(other) == registrar
        ) revert UnsupportedToken();
        (uint256 rewardBefore, bool seatBefore) = _rescueSnapshot();
        other.safeTransfer(to, other.balanceOf(address(this)));
        _rescueCheck(rewardBefore, seatBefore);
    }

    // ---------------------------------------------------------------- internals

    function _end() internal {
        ended = true;
        // forge-lint: disable-next-line(unsafe-typecast)
        endedAt = uint64(block.timestamp);
        emit Ended(msg.sender, endedAt);
    }

    function _clearApproval() internal {
        if (approvedUntil == 0) return;
        emit PairingCleared(approvedDigest);
        approvedDigest = bytes32(0);
        approvedUntil = 0;
        approvedChain = 0;
    }

    /// @dev A rescue calls a contract the owner named. Whatever that contract is, the call must leave the reward
    /// token's balance and the seat where they were: a second entry point of the reward token (an alias or a proxy
    /// the token trusts) would otherwise let the owner take the provider's share, and a proxy the collection trusts
    /// could move the seat with the bookkeeping intact. The seat's own return (`withdrawNFT`) never runs these reads.
    function _rescueSnapshot() internal view returns (uint256 rewardBalance, bool seatHere) {
        rewardBalance = rewardToken.balanceOf(address(this));
        seatHere = collection.ownerOf(tokenId) == address(this);
    }

    function _rescueCheck(uint256 rewardBefore, bool seatBefore) internal view {
        if (rewardToken.balanceOf(address(this)) != rewardBefore) revert UnsupportedToken();
        if (seatBefore && collection.ownerOf(tokenId) != address(this)) revert UnsupportedToken();
    }

    function _settle(uint256 balance) internal {
        uint256 known = accounted;
        if (balance <= known) return;
        uint256 received = balance - known;
        uint256 ownerShare = Math.mulDiv(received, BPS - providerBps, BPS);
        uint256 providerShare = received - ownerShare;
        claimable[owner] += ownerShare;
        claimable[provider] += providerShare;
        accounted = balance;
        emit Settled(received, ownerShare, providerShare);
    }

    /// @dev Sends exactly `amount` of the reward token: the vault's balance must fall by it and the recipient's rise
    /// by it.
    function _pushExact(address to, uint256 amount) internal {
        uint256 before = rewardToken.balanceOf(address(this));
        uint256 toBefore = rewardToken.balanceOf(to);
        rewardToken.safeTransfer(to, amount);
        if (before - rewardToken.balanceOf(address(this)) != amount || rewardToken.balanceOf(to) - toBefore != amount) {
            revert UnsupportedToken();
        }
    }
}

/// @title SeatVaultFactory: one fresh vault per agreement, all pinned to the same collection, reward token,
/// registrar and relay, so a vault can never be misconfigured by the parties.
contract SeatVaultFactory {
    IERC721 public immutable collection;
    IERC20 public immutable rewardToken;
    address public immutable registrar;
    string public relayOrigin;
    address[] public vaults;

    error InvalidConfiguration();

    event VaultCreated(
        address indexed vault, address indexed owner, address indexed provider, uint256 tokenId, uint16 providerBps
    );

    constructor(IERC721 collection_, IERC20 rewardToken_, address registrar_, string memory relayOrigin_) {
        if (
            address(collection_).code.length == 0 || address(rewardToken_).code.length == 0
                || registrar_.code.length == 0 || address(collection_) == address(rewardToken_)
                || registrar_ == address(collection_) || registrar_ == address(rewardToken_)
                || bytes(relayOrigin_).length == 0
        ) revert InvalidConfiguration();
        collection = collection_;
        rewardToken = rewardToken_;
        registrar = registrar_;
        relayOrigin = relayOrigin_;
    }

    /// @notice The caller becomes the vault's owner (the NFT depositor).
    function create(address provider, address operator, uint256 tokenId, uint16 providerBps, bytes32 deviceKey)
        external
        returns (SeatVault vault)
    {
        vault = new SeatVault(
            msg.sender,
            provider,
            operator,
            collection,
            tokenId,
            rewardToken,
            providerBps,
            deviceKey,
            registrar,
            relayOrigin
        );
        vaults.push(address(vault));
        // forge-lint: disable-next-line(reentrancy-events)
        emit VaultCreated(address(vault), msg.sender, provider, tokenId, providerBps);
    }

    function count() external view returns (uint256) {
        return vaults.length;
    }
}
