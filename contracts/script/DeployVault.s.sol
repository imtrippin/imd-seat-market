// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {SeatVault, SeatVaultFactory} from "../src/SeatVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {MockERC20} from "../test/Mocks.sol";
import {MockERC721, MockRegistrar} from "../test/VaultMocks.sol";

/// @dev Testnet rehearsal of the vault set with mocks standing in for IMD's pieces (the seat collection, the IMD
/// token, IMD's registrar). The deployer plays the owner and the "Disperse" payer; PROVIDER and OPERATOR are
/// throwaway addresses. Nothing here talks to IMD.
///   PROVIDER=0x... OPERATOR=0x... forge script script/DeployVault.s.sol --rpc-url <base sepolia> --broadcast \
///     --private-key <throwaway deployer key>
contract DeployVault is Script {
    uint256 constant TOKEN = 2048;
    uint16 constant PROVIDER_BPS = 3000;

    function run() external {
        require(block.chainid == 11155111 || block.chainid == 84532, "testnet only: Sepolia or Base Sepolia");
        address provider = vm.envAddress("PROVIDER");
        address operator = vm.envAddress("OPERATOR");
        bytes32 deviceKey = keccak256("rehearsal device key");
        vm.startBroadcast();
        address owner = msg.sender;
        MockERC721 seats = new MockERC721();
        MockERC20 imd = new MockERC20();
        MockRegistrar registry = new MockRegistrar();
        SeatVaultFactory factory = new SeatVaultFactory(
            IERC721(address(seats)), IERC20(address(imd)), address(registry), "https://api.imd.fun"
        );
        seats.mint(owner, TOKEN);
        imd.mint(owner, 1_000e18); // the deployer will play the reward payer
        SeatVault vault = factory.create(provider, operator, TOKEN, PROVIDER_BPS, deviceKey);
        vm.stopBroadcast();
        console.log("chain", block.chainid);
        console.log("MockERC721 seats", address(seats));
        console.log("MockERC20 imd", address(imd));
        console.log("MockRegistrar", address(registry));
        console.log("SeatVaultFactory", address(factory));
        console.log("SeatVault", address(vault));
        console.log("owner (deployer)", owner);
        console.log("provider", provider);
        console.log("operator", operator);
    }
}
