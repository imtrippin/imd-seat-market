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

/// @dev Stands in for the ERC-8004 identity registry: records who called it and with what.
contract MockRegistry {
    address public lastCaller;
    bytes public lastData;
    bool public shouldFail;

    function setFail(bool fail) external {
        shouldFail = fail;
    }

    fallback() external {
        require(!shouldFail, "registry: refused");
        lastCaller = msg.sender;
        lastData = msg.data;
    }
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
        (bool ok, bytes memory reason) = address(target).call(abi.encodeCall(SeatVault.claim, (this)));
        if (!ok && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()"))) blocked++;
        (ok, reason) = address(target).call(abi.encodeCall(SeatVault.settle, (this)));
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
