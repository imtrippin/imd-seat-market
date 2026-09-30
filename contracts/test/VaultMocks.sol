// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SeatVault} from "../src/SeatVault.sol";
import {MockERC20} from "./Mocks.sol";

/// @dev Stands in for the IMD seat collection.
contract MockERC721 is ERC721 {
    constructor() ERC721("Mock seats", "mSEAT") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// @dev Stands in for IMD's registrar (`Adapter8004`, verified source read 2026-09-29): `register(uint8 standard,
/// address tokenContract, uint256 tokenId, string agentURI)`, with or without metadata entries, may be called only by
/// the token's current owner; the reserved binding metadata key is refused; the ERC-8004 agent it creates stays with
/// the registrar, whose wallet entry is cleared again; control of the agent follows whoever owns the bound token.
/// Records the last call, can be told to refuse outright, or to fail after the agent was minted (a downstream
/// registry write failing), which must unwind the whole registration.
contract MockRegistrar {
    struct Binding {
        address tokenContract;
        uint256 tokenId;
    }

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    string public constant BINDING_KEY = "agent-binding";
    address public lastCaller;
    bytes public lastData;
    bool public shouldFail;
    bool public shouldFailAfterRegister;
    uint256 public agentCount;
    mapping(uint256 => Binding) public bindings;
    mapping(uint256 => address) public agentWallet;
    mapping(uint256 => bytes) public bindingMetadata;

    error NotController(address account);
    error ReservedMetadataKey();
    error UnknownAgent(uint256 agentId);
    error Refused();
    error DownstreamRefused();

    function setFail(bool fail) external {
        shouldFail = fail;
    }

    function setFailAfterRegister(bool fail) external {
        shouldFailAfterRegister = fail;
    }

    function register(uint8, address tokenContract, uint256 tokenId, string calldata) external returns (uint256) {
        return _register(tokenContract, tokenId);
    }

    function register(uint8, address tokenContract, uint256 tokenId, string calldata, MetadataEntry[] calldata entries)
        external
        returns (uint256)
    {
        for (uint256 i; i < entries.length; ++i) {
            if (keccak256(bytes(entries[i].metadataKey)) == keccak256(bytes(BINDING_KEY))) {
                revert ReservedMetadataKey();
            }
        }
        return _register(tokenContract, tokenId);
    }

    /// @dev As on mainnet: whoever currently owns the bound token controls the agent.
    function isController(uint256 agentId, address account) external view returns (bool) {
        Binding memory b = bindings[agentId];
        return b.tokenContract != address(0) && IERC721(b.tokenContract).ownerOf(b.tokenId) == account;
    }

    /// @dev As on mainnet: the immutable binding (standard, collection, token), or a revert for an unknown agent.
    function bindingOf(uint256 agentId) external view returns (uint8 standard, address tokenContract, uint256 tokenId) {
        Binding memory b = bindings[agentId];
        if (b.tokenContract == address(0)) revert UnknownAgent(agentId);
        return (0, b.tokenContract, b.tokenId);
    }

    /// @dev The registrar itself holds the agent NFT in the ERC-8004 registry.
    function ownerOf(uint256 agentId) external view returns (address) {
        require(bindings[agentId].tokenContract != address(0), "unknown agent");
        return address(this);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return agentWallet[agentId];
    }

    function _register(address tokenContract, uint256 tokenId) internal returns (uint256 agentId) {
        if (shouldFail) revert Refused();
        if (IERC721(tokenContract).ownerOf(tokenId) != msg.sender) revert NotController(msg.sender);
        lastCaller = msg.sender;
        lastData = msg.data;
        agentId = ++agentCount; // the registry mints the agent to the registrar
        agentWallet[agentId] = address(this); // and records the minter as its wallet
        bindings[agentId] = Binding(tokenContract, tokenId);
        if (shouldFailAfterRegister) revert DownstreamRefused(); // a later registry write fails
        bindingMetadata[agentId] = abi.encodePacked(address(this)); // the registrar's own binding record
        agentWallet[agentId] = address(0); // and it clears the wallet again
    }
}

/// @dev A registrar implementation that accepts any call through a bare fallback and registers nothing.
contract SilentRegistrar {
    fallback() external {}
}

/// @dev Reward token that re-enters the vault from inside every transfer and counts guard rejections.
contract ReenteringRewardToken is MockERC20 {
    SeatVault public target;
    uint256 public blocked;

    function arm(SeatVault target_) external {
        target = target_;
        blocked = 0;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(target) == address(0) || from != address(target)) return;
        (bool ok, bytes memory reason) = address(target).call(abi.encodeCall(SeatVault.claim, ()));
        if (!ok && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()"))) blocked++;
        (ok, reason) = address(target).call(abi.encodeCall(SeatVault.settle, ()));
        if (!ok && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()"))) blocked++;
    }
}

/// @dev Delivers only 99% of an outgoing transfer while debiting the full amount.
contract RecipientTaxRewardToken is MockERC20 {
    address public taxedSender;

    function setTaxedSender(address sender) external {
        taxedSender = sender;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == taxedSender && to != address(0)) {
            uint256 tax = value / 100;
            super._update(from, address(0), tax);
            super._update(from, to, value - tax);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Balances can shrink outside transfers (a negative rebase).
contract ShrinkingRewardToken is MockERC20 {
    function shrink(address holder, uint256 amount) external {
        _burn(holder, amount);
    }
}

/// @dev A fixed-balance reward token with a second entry point (an alias or proxy contract the token trusts, the
/// TUSD / Synthetix pattern): `entry` reads and moves the same balances on behalf of its caller.
contract AliasedRewardToken is MockERC20 {
    RewardEntry public immutable entry;

    constructor() {
        entry = new RewardEntry(this);
    }

    function entryTransfer(address from, address to, uint256 amount) external {
        require(msg.sender == address(entry), "entry only");
        _transfer(from, to, amount);
    }
}

contract RewardEntry {
    AliasedRewardToken public immutable token;

    constructor(AliasedRewardToken token_) {
        token = token_;
    }

    function balanceOf(address who) external view returns (uint256) {
        return token.balanceOf(who);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        token.entryTransfer(msg.sender, to, amount);
        return true;
    }
}

/// @dev A seat collection that trusts a mover contract, so a token could leave through an address other than the
/// collection's own.
contract ProxiedCollection is MockERC721 {
    CollectionEntry public immutable entry;

    constructor() {
        entry = new CollectionEntry(this);
    }

    function entryTransfer(address from, address to, uint256 id) external {
        require(msg.sender == address(entry), "entry only");
        _transfer(from, to, id);
    }
}

contract CollectionEntry {
    ProxiedCollection public immutable collection;

    constructor(ProxiedCollection collection_) {
        collection = collection_;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        collection.entryTransfer(from, to, id);
    }
}
