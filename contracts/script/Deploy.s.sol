// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {SeatEscrow} from "../src/SeatEscrow.sol";
import {MockERC20} from "../test/Mocks.sol";

/// @dev Testnet deployment: the escrow plus a mock token standing in for IMD (which exists only on mainnet).
///   forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $DEPLOYER_KEY
/// Use a throwaway key with testnet ETH only. Never run this from a worker box.
contract Deploy is Script {
    function run() external {
        require(block.chainid == 11155111 || block.chainid == 84532, "testnet only: Sepolia or Base Sepolia");
        vm.startBroadcast();
        MockERC20 token = new MockERC20();
        SeatEscrow escrow = new SeatEscrow();
        vm.stopBroadcast();
        console.log("MockERC20", address(token));
        console.log("SeatEscrow", address(escrow));
    }
}
