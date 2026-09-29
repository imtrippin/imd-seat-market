# SeatVault (contracts)

The on-chain piece of Seat Market: **one vault per hosted seat**. The owner puts the seat NFT in the vault, the host pairs its worker to it, every reward that reaches the vault is split by a fixed percentage, and the owner can take the NFT back at any time. There is no fee, no deposit and no second contract.

**Status: local Foundry project with unit, fuzz, sequence-fuzz and review-probe suites. Deployed only as a mock rehearsal on Base Sepolia with throwaway keys; not on mainnet, not paired with IMD. Not audited.**

## The rule, in one sentence

You keep an agreed percentage of every reward that reaches your vault and the host receives the rest; the host can never move the NFT, and you can withdraw it whenever you want.

## What the contract does

- **Terms**: the factory pins the seat collection, the reward token, the identity registry and the relay origin for every vault it creates; the creator (who becomes the owner) supplies the host (`provider`), the host's pairing key (`operator`, distinct from both), the token id, the host's share in basis points and the initial device key. All of these are immutable except the device key, which the owner may replace with `setDeviceKey` (clearing any pairing approval) to move to a replacement machine of the same host.
- **Custody**: `deposit()` moves the NFT in (only the agreed token, only from the owner, only once). `withdrawNFT(to)` moves it out whenever the vault actually holds it, before or after the agreement ended, even if it arrived by a plain transfer, without the host and without any call to the reward token. Withdrawal ends the agreement and clears any pairing approval. The host can `end()` the agreement (no new pairings) only once the seat is in the vault; the owner can end at any time.
- **Pairing** (ERC-1271): the owner approves one pairing at a time with `approvePairing(nonce, expiresAt, relayOrigin)`; the vault answers `isValidSignature` only for that digest, unexpired, on this chain, signed by the host's pairing key or the owner. Changing the device key, revoking, ending or withdrawing clears it. A device IMD already enrolled is not disconnected by the vault; moving the NFT out is what makes it stale on IMD's side.
- **Rewards**: `settle(token)` allocates every unit that arrived since the last settlement (owner gets the floor of its share, host the remainder); `claim(token)` settles first and pays the caller's own allocation exactly, or, if an unsupported token's balance fell outside transfers, what the vault actually holds, keeping the rest allocated. Any ERC-20 that lands in the vault is split the same way; the seat collection and the registry are refused as `token` (their `balanceOf` is a token count). `registerAgent(data)` lets the owner send the ERC-8004 registration through the vault to the pinned registry, and only the registry's three `register` functions go through; `rescueERC721` returns any other NFT, such as the agent NFT, never the seat and never the reward token.
- **Safety**: exact-amount checks on every payout; reentrancy guards on every function that moves tokens or calls the registry (`withdrawNFT`, `registerAgent`, `settle`, `claim`, `rescueERC721`); zero-address checks on withdrawals and rescues; full-precision split; no admin, no upgrade path, no sweep. There is also no role rotation: the owner address must be a wallet you can always control (a multisig works, since the owner never signs a pairing digest; the host's operator key does), and a lost owner key strands the seat in the vault.
- **Supported assets**: one plain, fixed-balance ERC-20 (IMD is one). A token whose balances change outside transfers (rebasing, upgradeable, pausable, dishonest `balanceOf`) can leave the last claimant short; `shortfall(token)` shows the gap. The seat's return never depends on the reward token.

## What it deliberately does not do

- It cannot make IMD pay the vault: only rewards that actually reach it are split. Where a payout lands depends on IMD's routing (the holder at payout time, or an earlier snapshot), which is unverified.
- It does not judge service, attribute rewards to jobs, guarantee any income to the host, or stop the owner from withdrawing right before a payout. Hosts price those risks into their percentage.
- It does not observe uptime or pause a worker. The public IMD standing routes (imd.fun/docs) are the evidence source for service and disputes.

## Layout

```text
src/SeatVault.sol                 the vault and its factory (Solidity 0.8.30, OpenZeppelin 5.4.0)
test/SeatVault.t.sol              unit tests: custody, pairing digests, splits, claims, exit, reentrancy, token edge cases
test/SeatVaultReviewProbes.t.sol  regressions from the first review round (custody after end, single approval, registries)
test/SeatVaultV2Probes.t.sol      regressions from the second round (malformed reward tokens, two-vault custody fuzz)
test/codex/SeatVaultRound3.t.sol  the third round's probes
test/SeatVaultSwarmProbes.t.sol   regressions and coverage cases from the IMD swarm review (job 11c42a8c)
test/SeatVaultInvariants.t.sol    handler-driven invariants over the reward ledger and the seat's whereabouts
test/fork/MainnetFork.t.sol       mainnet fork rehearsal against the real collection, token and registry (needs MAINNET_RPC_URL)
test/Mocks.sol, test/VaultMocks.sol  the mock token, collection, registry and hostile tokens
script/DeployVault.s.sol          testnet deployment of mocks, factory and one vault
script/pair-vault.mjs             the pairing helper (prepare/complete, dry run by default; see the file header)
script/testnet-walkthrough.sh     the asserting lifecycle rehearsal against a testnet deployment
```

## Run

```text
forge build
forge test              # unit, fuzz and review-probe suites (the count is printed by CI)
forge test --gas-report
forge fmt --check src test script
MAINNET_RPC_URL=<mainnet rpc> FORK_SEAT=<seat token id> forge test --match-contract MainnetFork -vv   # optional fork rehearsal
```

The fork rehearsal (`test/fork/MainnetFork.t.sol`) impersonates the seat's wallet on a mainnet fork and runs deposit, plain transfer, pairing digest, registration through the vault against the real ERC-8004 registry, a reward split with the real IMD token, withdrawal and rescue, plus the checks that nobody else can move the seat. It skips unless both `MAINNET_RPC_URL` and `FORK_SEAT` (any seat's token id; its current holder is read from the collection and impersonated) are set, so CI never touches a network; `FORK_BLOCK` pins the fork to a block. The IMD seat collection (`0x0000eC93…`, verified `IdentityMD`, not a proxy) has no pause, blocklist or transfer hook; its owner-only functions only set identity hashes and Uniswap pointers.

Foundry 1.8.3 is the pinned toolchain (the same release the IMD verifier runs). Dependencies are git submodules pinned in `foundry.lock`: `lib/openzeppelin-contracts` v5.4.0, `lib/forge-std` v1.16.2.

## Gas (unit suites, `forge test --gas-report`, median)

| Function | Gas |
| --- | ---: |
| factory `create` (deploys a vault) | 2,115k |
| deposit | 93k |
| approvePairing | 97k |
| settle | 49k |
| claim | 86k |
| withdrawNFT | 75k |
| end | 47k |

The vault lives on the seat's chain, so mainnet gas applies; a clone factory (EIP-1167) would cut creation cost by roughly ten times and is the obvious follow-up if listings are many.

## Review history

- 2026-09-28, Codex, round one: custody could strand the seat after a plain transfer and a host `end()`; an unreadable or huge reward-token balance blocked withdrawal; approvals survived device changes and several coexisted; a safe-minting registry could not deliver its agent token; script expiry and guard issues. All fixed; regressions in `test/SeatVaultReviewProbes.t.sol` and `test/pair-vault.test.mjs`.
- 2026-09-28, Codex, round two: malformed `balanceOf` return data still trapped the seat (fixed: withdrawal makes no call to the reward token); the rehearsal script could execute a call twice (fixed: one signed transaction per call, never rebuilt); the pairing helper ignored IMD's code expiry and accepted fractional TTLs (fixed). Regressions in `test/SeatVaultV2Probes.t.sol` and six more script tests.
- 2026-09-28, Codex, round three: three low script findings (nonce read failure, receipts for another hash, token-id encoding), all fixed; probes under `test/codex/`.
- 2026-09-29, Codex and Claude readiness reviews, then the owner's decision to ship the vault alone: the rental escrow that used to sit beside it (a daily fee drawn from a deposit) was removed from the tree with its suites; its review history is in `../review/HISTORY.md` and the code in git history.
- 2026-09-29, IMD swarm review (job `11c42a8c`, `audit-imported-code`, commit `a51f9130`): 1 medium (a claim on the seat collection or the registry as `token` could move a seat on a collection with a legacy `transfer(address,uint256)`; the pinned IMD collection has none), 4 low (a provider could `end()` before the seat arrived and brick a fresh vault; the pairing helper read millisecond timestamps as seconds; claims were all-or-nothing under a shortfall; `registerAgent` forwarded any calldata) and 5 informational items. All fixed the same day except the two accepted as design notes (no role rotation; key handling in the testnet rehearsal script); regressions and the requested invariant suite are in `test/SeatVaultSwarmProbes.t.sol` and `test/SeatVaultInvariants.t.sol`.
- 2026-09-29, Codex, review of the swarm fixes: all confirmed; one low test-harness defect (the invariant handler's re-deposit action consumed its own `vm.prank` on a getter and never ran) fixed with a deterministic regression, and the invariant campaign now fails on any unexpected revert.

## Next steps

1. Independent review (`../docs/SWARM-REVIEW-BRIEF.md`).
2. The live questions only IMD can answer (pairing with a contract holder, payouts to a contract holder, agent registration through the vault, and whether the registry charges an ETH fee the vault cannot pay), each as a separately approved step with one spare seat.
3. Wire the site to the factory and the vault: create, deposit, approve pairing, claim, withdraw.
