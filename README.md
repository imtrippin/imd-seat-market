# Seat Market contracts

Two small Solidity contracts for letting someone else host an IMD seat NFT, with the money rules enforced on-chain:

- **SeatEscrow**: a rental with a security deposit. An agreed daily fee accrues per second until either party ends; the host can draw unpaid fee from the owner's deposit; the owner takes back whatever is left after unpaid fee; a reward share can be paid on top, voluntarily and referenced.
- **SeatVault**: an NFT-holding vault. The owner places one seat NFT in it, approves each pairing signature narrowly (ERC-1271), every reward-token transfer that reaches the vault is split by immutable percentages, each party claims its own allocation, and the owner can take the NFT back at any time without the host and without any call to the reward token.

They compose but are independent: rent lives in the escrow, custody and the reward split in the vault. Which combination a listing uses (fee, percentage, deposit) is the parties' choice, not a platform rule.

**Status: prototype.** Unit, fuzz, invariant and review-probe suites; three reviewer rounds on the vault and two on the escrow, with every reproduction kept as a regression; a scripted rehearsal on Base Sepolia against mocks. Not audited, not deployed on mainnet, not paired with IMD. The integration points that only a live IMD test can settle are listed in [the review brief](docs/SWARM-REVIEW-BRIEF.md). Nothing in this repository pairs a device, deploys to mainnet, moves an NFT or pays anyone.

## Layout

```text
contracts/src/          SeatEscrow.sol, SeatVault.sol (+ SeatVaultFactory)
contracts/test/         Foundry suites, mocks, regressions adopted from each review round
contracts/script/       testnet deployment scripts, the pairing helper (pair-vault.mjs) and the rehearsal walkthrough
contracts/README.md     the escrow's rule, guarantees, gas and review history
contracts/VAULT-DESIGN.md  the vault's design, trust limits and open integration questions
docs/SWARM-REVIEW-BRIEF.md the brief for an independent review
test/                   offline tests of the pairing helper and the walkthrough's send logic
review/HISTORY.md       a sanitized summary of the review chain
```

## Run

```text
cd contracts && forge build && forge test && forge fmt --check src test script   # Foundry 1.8.3, solc 0.8.30
npm test                                                                        # Node 22+, needs a Python 3 interpreter (REVIEW_PYTHON=...)
node contracts/script/pair-vault.mjs --selftest
```

Dependencies are git submodules (`git clone --recursive`): OpenZeppelin Contracts v5.4.0 and forge-std v1.16.2, pinned in `contracts/foundry.lock`.

## History

The project started as a JavaScript simulation of the marketplace (versions 0.1 to 0.3, a per-period floor with owner acknowledgments). The contracts replaced that model with the simpler rules above; the simulation, its tests and its review artefacts were removed from the tree on 2026-09-29 and remain in git history. `review/HISTORY.md` records what each review established.

## License

No license is granted yet. The contract sources carry `UNLICENSED` identifiers; vendored dependencies keep their own licenses.
