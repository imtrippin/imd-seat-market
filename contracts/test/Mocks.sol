// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Plain 18-decimal token standing in for IMD on a testnet.
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock IMD", "mIMD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
