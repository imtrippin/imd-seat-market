# Seat Market contracts

One small Solidity contract for letting someone else host an IMD seat NFT, with the money rule enforced on-chain:

**SeatVault**: the owner places one seat NFT in a vault, approves each pairing signature narrowly (ERC-1271), every reward-token transfer that reaches the vault is split by immutable percentages, each party claims its own allocation, and the owner can take the NFT back at any time without the host and without any call to the reward token. No fee, no deposit, no admin.

The listing's only number is the host's percentage. Everything else the host offers (machine, skills, model access, support) is a promise the vault does not judge; an idle seat pays nothing, and the owner may leave at any moment.

**Status: prototype.** Unit, fuzz, invariant and review-probe suites; three reviewer rounds and one IMD swarm review, with every reproduction kept as a regression; a scripted rehearsal on Base Sepolia against mocks. Not audited, not deployed on mainnet, not paired with IMD. The integration points that only a live IMD test can settle are listed in [the review brief](docs/SWARM-REVIEW-BRIEF.md). The tests run against mocks and never touch a chain; the pairing helper is a dry run unless its live flags are set; the testnet scripts sign and broadcast only when deliberately run with keys and an RPC, and refuse any chain but Sepolia or Base Sepolia.

## Layout

```text
contracts/src/          SeatVault.sol (+ SeatVaultFactory)
contracts/test/         Foundry suites, mocks, regressions adopted from each review round
contracts/script/       testnet deployment script, the pairing helper (pair-vault.mjs) and the rehearsal walkthrough
contracts/README.md     the rule, guarantees, gas and review history
contracts/VAULT-DESIGN.md  the design, trust limits and open integration questions
docs/SWARM-REVIEW-BRIEF.md the brief for an independent review
host/                   the host helper (offer, pair, resume, status) and the shared library; its tests run the whole flow offline
page/                   the agreement page: one static file for the owner and the host, built from host/lib
test/                   offline tests of the pairing helper and the walkthrough's send logic
review/HISTORY.md       a sanitized summary of the review chain
```

## Run

```text
cd contracts && forge build && forge test && forge fmt --check src test script   # Foundry 1.8.3, solc 0.8.30
npm test                                                                        # Node 22+, needs a Python 3 interpreter (REVIEW_PYTHON=...)
node contracts/script/pair-vault.mjs --selftest
cd host && npm install && npm test         # helper unit tests + an offline end-to-end run on anvil
cd page && npm install && npm run build    # the static agreement page → page/dist
```

Dependencies are git submodules (`git clone --recursive`): OpenZeppelin Contracts v5.4.0 and forge-std v1.16.2, pinned in `contracts/foundry.lock`.

## History

The project started as a JavaScript simulation of the marketplace (versions 0.1 to 0.3, a per-period floor with owner acknowledgments), then a rental escrow contract (a daily fee drawn from a deposit) was built and reviewed beside the vault. Both were removed from the tree on 2026-09-29 to keep a single, simple rule; they remain in git history, and `review/HISTORY.md` records what each review established.

## License

No license is granted yet. The contract sources carry `UNLICENSED` identifiers; vendored dependencies keep their own licenses.
