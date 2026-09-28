// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SeatVault: holds exactly one IMD seat NFT for one hosting agreement, so that rewards paid to the NFT's
/// holder arrive here and are split by immutable terms.
/// @notice Experimental, local prototype. What this vault enforces: the split of every reward-token transfer that
/// actually reaches it, and the owner's right to take the NFT back without the provider. What it does not do:
/// judge service, attribute rewards to jobs or periods, or revoke a device that IMD already enrolled (moving the
/// NFT out is what makes that device stale on IMD's side). Rent and collateral stay in SeatEscrow; this contract
/// never accepts deposits, so nothing here can be mistaken for a reward.
///
/// Pairing authority. IMD pairs a device to a seat by verifying an EIP-712 `WorkerAuthorization` signature from
/// the seat holder; for a contract holder it calls `isValidSignature(digest, signature)` (ERC-1271). This vault
/// answers valid only for a digest the owner approved on-chain for the agreed device key and relay, before its
/// expiry, when the signature is by the agreed operator key (or the owner). The operator key can do nothing else.
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
    uint256 public constant BPS = 10_000;

    address public immutable owner;
    address public immutable provider;
    address public immutable operator;
    IERC721 public immutable collection;
    uint256 public immutable tokenId;
    IERC20 public immutable rewardToken;
    uint16 public immutable providerBps;
    address public immutable identityRegistry;
    uint256 public immutable escrowAgreementId;
    bytes32 public immutable relayOriginHash;
    string public relayOrigin;

    bytes32 public deviceKey;
    bool public held;
    bool public ended;
    uint64 public endedAt;
    mapping(bytes32 => uint64) public pairingApprovedUntil;
    mapping(bytes32 => uint256) public pairingApprovedChain;
    /// @dev Per token: balance already allocated to the two parties (still inside the vault until claimed).
    mapping(IERC20 => uint256) public accounted;
    mapping(IERC20 => mapping(address => uint256)) public claimable;

    event NFTDeposited(address indexed from);
    event NFTWithdrawn(address indexed to);
    event DeviceKeySet(bytes32 deviceKey);
    event PairingApproved(bytes32 indexed digest, bytes32 deviceKey, bytes32 nonce, uint64 expiresAt);
    event PairingRevoked(bytes32 indexed digest);
    event Settled(IERC20 indexed token, uint256 received, uint256 ownerShare, uint256 providerShare);
    event Claimed(IERC20 indexed token, address indexed party, uint256 amount);
    event Ended(address indexed by, uint64 endedAt);
    event AgentRegistered(bytes data);

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

    constructor(
        address owner_,
        address provider_,
        address operator_,
        IERC721 collection_,
        uint256 tokenId_,
        IERC20 rewardToken_,
        uint16 providerBps_,
        bytes32 deviceKey_,
        address identityRegistry_,
        string memory relayOrigin_,
        uint256 escrowAgreementId_
    ) {
        if (
            owner_ == address(0) || provider_ == address(0) || operator_ == address(0) || owner_ == provider_
                || address(collection_) == address(0) || address(rewardToken_) == address(0)
                || identityRegistry_ == address(0) || providerBps_ > BPS || deviceKey_ == bytes32(0)
                || bytes(relayOrigin_).length == 0
        ) revert InvalidTerms();
        owner = owner_;
        provider = provider_;
        operator = operator_;
        collection = collection_;
        tokenId = tokenId_;
        rewardToken = rewardToken_;
        providerBps = providerBps_;
        deviceKey = deviceKey_;
        identityRegistry = identityRegistry_;
        relayOrigin = relayOrigin_;
        relayOriginHash = keccak256(bytes(relayOrigin_));
        escrowAgreementId = escrowAgreementId_;
    }

    // ---------------------------------------------------------------- custody

    /// @notice Pulls the seat NFT from the owner (needs an ERC-721 approval to this vault first).
    function deposit() external {
        if (msg.sender != owner) revert NotOwner();
        collection.safeTransferFrom(owner, address(this), tokenId);
    }

    /// @notice Accepts only the agreed seat NFT, only from the owner, only once, only before exit. Anything else
    /// reverts, so a wrong `safeTransferFrom` fails instead of getting stuck.
    function onERC721Received(address, address from, uint256 id, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(collection) || id != tokenId) revert WrongToken();
        if (from != owner) revert NotOwner();
        if (held) revert AlreadyHeld();
        if (ended) revert AlreadyEnded();
        held = true;
        emit NFTDeposited(from);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice If the NFT arrived by a plain `transferFrom` (no callback), the owner records it here.
    function syncHeld() external {
        if (msg.sender != owner) revert NotOwner();
        if (held || ended) revert AlreadyHeld();
        if (collection.ownerOf(tokenId) != address(this)) revert NotHeld();
        held = true;
        emit NFTDeposited(owner);
    }

    /// @notice The owner takes the NFT back at any time, without the provider. Rewards that already reached the
    /// vault are allocated first; the agreement ends; new pairings are refused from now on. On IMD's side the
    /// enrolled device goes stale because the holder changed; that is the revocation, nothing here disconnects it.
    function withdrawNFT(address to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        if (!held) revert NotHeld();
        _settle(rewardToken);
        if (!ended) _end();
        held = false;
        collection.safeTransferFrom(address(this), to, tokenId);
        emit NFTWithdrawn(to);
    }

    /// @notice Either party ends the agreement: no new pairing can be approved or validated. The NFT stays until
    /// the owner withdraws it; allocations stay claimable.
    function end() external {
        if (msg.sender != owner && msg.sender != provider) revert NotParty();
        if (ended) revert AlreadyEnded();
        _end();
    }

    // ---------------------------------------------------------------- pairing (ERC-1271)

    /// @notice The owner may point the agreement at a replacement device of the same provider.
    function setDeviceKey(bytes32 deviceKey_) external {
        if (msg.sender != owner) revert NotOwner();
        if (ended) revert AlreadyEnded();
        if (deviceKey_ == bytes32(0)) revert InvalidTerms();
        deviceKey = deviceKey_;
        emit DeviceKeySet(deviceKey_);
    }

    /// @notice Owner approves one pairing attempt: the exact WorkerAuthorization digest for the agreed device, this
    /// vault as wallet, this token, IMD's nonce and the agreed relay, valid until `expiresAt` (at most one hour).
    /// The `nonce` comes from IMD's pairing response; the approval must be mined before the host completes pairing.
    function approvePairing(bytes32 nonce, uint64 expiresAt, string calldata relayOrigin_)
        external
        returns (bytes32 digest)
    {
        if (msg.sender != owner) revert NotOwner();
        if (!held || ended) revert NotPairable();
        if (keccak256(bytes(relayOrigin_)) != relayOriginHash) revert WrongRelay();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_PAIRING_WINDOW) revert BadExpiry();
        digest = workerAuthorizationDigest(deviceKey, nonce, expiresAt);
        pairingApprovedUntil[digest] = expiresAt;
        pairingApprovedChain[digest] = block.chainid;
        emit PairingApproved(digest, deviceKey, nonce, expiresAt);
    }

    /// @notice Withdraws an approval that has not been used. Does not touch a device IMD already enrolled.
    function revokePairing(bytes32 digest) external {
        if (msg.sender != owner) revert NotOwner();
        pairingApprovedUntil[digest] = 0;
        pairingApprovedChain[digest] = 0;
        emit PairingRevoked(digest);
    }

    /// @notice ERC-1271. Valid only for an owner-approved, unexpired WorkerAuthorization digest, signed by the
    /// operator key or the owner, while the NFT is held and the agreement is open. Never reverts.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (!held || ended) return ERC1271_INVALID;
        uint64 until = pairingApprovedUntil[hash];
        if (until == 0 || block.timestamp > until || pairingApprovedChain[hash] != block.chainid) {
            return ERC1271_INVALID;
        }
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

    /// @notice The ERC-8004 registration transaction IMD asks the holder wallet to send (`GET /agents/register-intent`
    /// gives the calldata). The only call the owner can make through this vault, and only to the registry.
    function registerAgent(bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != owner) revert NotOwner();
        if (!held) revert NotHeld();
        bool ok;
        (ok, result) = identityRegistry.call(data);
        if (!ok) revert RegistryCallFailed();
        emit AgentRegistered(data);
    }

    // ---------------------------------------------------------------- rewards

    /// @notice Allocates every token unit that arrived since the last settlement: the owner gets the floor of its
    /// share, the provider the remainder. Anyone may call it; claims call it first.
    function settle(IERC20 token) external nonReentrant {
        _settle(token);
    }

    /// @notice A party takes its allocation of `token`. Rewards that arrived but were not yet settled are settled
    /// first, so nothing can be claimed past an incoming transfer.
    function claim(IERC20 token) external nonReentrant returns (uint256 amount) {
        if (msg.sender != owner && msg.sender != provider) revert NotParty();
        _settle(token);
        amount = claimable[token][msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[token][msg.sender] = 0;
        accounted[token] -= amount;
        _pushExact(token, msg.sender, amount);
        emit Claimed(token, msg.sender, amount);
    }

    /// @notice Unsettled balance of a token: what the next settlement would split.
    function pending(IERC20 token) external view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        uint256 known = accounted[token];
        return balance > known ? balance - known : 0;
    }

    /// @notice Moves an NFT that is not the seat (for example an agent registry token, or a mistake) to `to`.
    function rescueERC721(IERC721 other, uint256 id, address to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        if (address(other) == address(collection) && id == tokenId) revert UseWithdraw();
        other.safeTransferFrom(address(this), to, id);
    }

    // ---------------------------------------------------------------- internals

    function _end() internal {
        ended = true;
        // forge-lint: disable-next-line(unsafe-typecast)
        endedAt = uint64(block.timestamp);
        emit Ended(msg.sender, endedAt);
    }

    function _settle(IERC20 token) internal {
        uint256 balance = token.balanceOf(address(this));
        uint256 known = accounted[token];
        if (balance <= known) return;
        uint256 received = balance - known;
        uint256 ownerShare = (received * (BPS - providerBps)) / BPS;
        uint256 providerShare = received - ownerShare;
        claimable[token][owner] += ownerShare;
        claimable[token][provider] += providerShare;
        accounted[token] = balance;
        emit Settled(token, received, ownerShare, providerShare);
    }

    /// @dev Sends exactly `amount`: the vault's balance must fall by it and the recipient's rise by it.
    function _pushExact(IERC20 token, address to, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        uint256 toBefore = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (before - token.balanceOf(address(this)) != amount || token.balanceOf(to) - toBefore != amount) {
            revert UnsupportedToken();
        }
    }
}

/// @title SeatVaultFactory: one fresh vault per agreement, all pinned to the same collection, reward token,
/// identity registry and relay, so a vault can never be misconfigured by the parties.
contract SeatVaultFactory {
    IERC721 public immutable collection;
    IERC20 public immutable rewardToken;
    address public immutable identityRegistry;
    string public relayOrigin;
    address[] public vaults;

    event VaultCreated(
        address indexed vault, address indexed owner, address indexed provider, uint256 tokenId, uint16 providerBps
    );

    constructor(IERC721 collection_, IERC20 rewardToken_, address identityRegistry_, string memory relayOrigin_) {
        collection = collection_;
        rewardToken = rewardToken_;
        identityRegistry = identityRegistry_;
        relayOrigin = relayOrigin_;
    }

    /// @notice The caller becomes the vault's owner (the NFT depositor).
    function create(
        address provider,
        address operator,
        uint256 tokenId,
        uint16 providerBps,
        bytes32 deviceKey,
        uint256 escrowAgreementId
    ) external returns (SeatVault vault) {
        vault = new SeatVault(
            msg.sender,
            provider,
            operator,
            collection,
            tokenId,
            rewardToken,
            providerBps,
            deviceKey,
            identityRegistry,
            relayOrigin,
            escrowAgreementId
        );
        vaults.push(address(vault));
        emit VaultCreated(address(vault), msg.sender, provider, tokenId, providerBps);
    }

    function count() external view returns (uint256) {
        return vaults.length;
    }
}
