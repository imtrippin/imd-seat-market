# Review history

A sanitized summary of the review chain behind this project, so the repository is self-contained. The full reports, raw review-run records, source snapshots and screenshots are kept outside the repository, unchanged. The JavaScript simulation that the first three sections describe, together with its tests and review artefacts, was removed from the tree on 2026-09-29 and remains in git history. Dates are 2026-09-28 and times are UTC unless stated.

## Who did what

- **Codex** built the simulation's v0.1 (work-receipt model), v0.2 (collateral and arrival-time model) and v0.3 (per-period accounting, owner acknowledgment, draft contract specification) and wrote the responses; it later reviewed each contract version.
- **Claude (Fable 5.1)** reviewed each simulation version (two static reviews of v0.1's three source files with tools disabled, a workspace review of v0.1's trust model against public chain and worker evidence, a static collateral review plus a workspace review of v0.2 with a fuzz campaign, and a bounded static review of v0.3), then wrote the contracts and answered each contract review.

Each item below says which kind of evidence supports it.

## v0.1 and the trust-model review

- **Verified from public chain data.** IMD reward payments reach the NFT holder wallet from IMD's Disperse contract, one share per active agent: the three payouts observed between 2026-09-23 and 2026-09-28 paid about 7.7, 3.05 and 3.12 IMD per agent. The first was one aggregated transfer per wallet; the later two were one transfer per agent.
- **Reported by the IMD developer in on-chain notes, quoted.** "airdropped half of the token rewards to NFTs that performed tasks and run the daemon over the past 48 hours … around 7 imd to each agent" (09-23); "half to ppl with currently active nodes" (09-25); "sent the LP token rewards to workers and stakers" (09-28).
- **Adopted by the prototype.** The owner wallet receives every reward, so the provider is the trusting party. Because one payout aggregated per wallet, v1 requires one hosted NFT per dedicated receiving wallet.
- **Read from the pinned worker release (code inspection, not a live test).** The worker labels an enrollment `stale` with "the NFT moved to another wallet; run `imd start` to pair again", and `nft_transferred` is in its terminal-disconnect set. An NFT transfer therefore ends a hosted device's authority without the host's cooperation. Still untested live: whether the ERC-8004 agent id follows the token, and whether moving the token back revives the old enrollment.
- **Reported second-hand (2026-09-28).** The developer said a sold NFT stops work and task acceptance, with the server disconnecting roughly 30 minutes later. The timing has not been measured independently.
- **Documented by the public IMD API.** Pairing needs the seat holder wallet's EIP-712 signature; the only documented revoke is signed by the device itself; per-launch allocations and wallet earnings exist as records; no payout contract or claim route is documented.
- **Unsent asks for IMD.** A lockable per-seat payout address; EIP-1271 signature support at pairing so a vault could hold the NFT; a wallet-signed enrollment revoke.

## v0.2 review (collateral and arrival-time model)

- **Verified locally.** 39 focused tests passed. A 6,000-sequence action fuzz found 0 invariant failures, and every reachable state restored byte for byte. A headless-browser run of the lifecycle example matched the README's numbers.
- **Findings, with the v0.3 resolutions** (details in the v0.3 response, git history): the exposure warning ignored the unforwarded share (fixed: full-debt exposure in model and UI); a cumulative max let one payout pre-pay later floors (changed to fixed 24-hour periods anchored at activation); forwarding the whole arrival did not match the real flow (replaced by provider-only payments and separate top-ups); a deposit contract can enforce the time-based minimum without an oracle but not the share (owner acknowledgment now authorizes share draws); IMD's public seat and device standing routes are usable service evidence (documented, no watcher wired in); amendments cannot change deposit or minimum (now explicit); terms-text edits invalidated saved data (stable rule identifiers); clock advances were invisible to other agreements (shared clock events).

## v0.3 bounded static review

- **Scope.** The simulation's `dist/app.js`, `dist/model.js` and `server.mjs` with tools disabled and no internal documents, at these SHA-256 hashes: app `3a6623b443b1c66e0429d07fd41684a8c2ee2630f18b0adc4edc3d3b6f545065`, model `c9a337e0fadc55d4b6b15166b71c5764e0593ca98fd0039c45467f76d793c841`, server `6fc5b5a3455d71f34680cde4b5b0f42639a43493ab54c1028103ad452db810ff`. The report is in git history.
- **Verdict.** No blocker in per-period accounting, owner-only acknowledgment, refunds after the cutoff, or restore consistency. Four non-blocking display and form observations, plus the production prerequisites listed in the report.
- **After the review.** Codex changed display, timestamp and form-guidance details only. On the committed tree the 53-test suite and both fuzz seeds (105,958 applied actions) passed.

## The contracts (2026-09-28)

- **Decision.** The owner chose a rental with a security deposit over the simulation's floor-and-acknowledgment rule: listings set a daily fee, a reward-share percentage and a deposit, any of the first two may be zero, and the parties choose the numbers. `SeatEscrow` implements exactly that. A first floor-and-acknowledgment contract was built and reviewed the same day and then replaced; the git history was rebuilt, so its commits no longer exist.
- **Escrow reviews.** Codex, first review (floor model): two medium findings, fixed the same day; its probes that still apply live in `contracts/test/SeatEscrowReviewProbes.t.sol`. Codex, second review (rental model): a recipient-tax token could short-pay claims and refunds (fixed: `_pushExact` checks the recipient side), two amount paths bypassed the 2^128 claim cap (fixed), a tautological invariant (replaced), plus documentation and deploy-guard items; its reproductions became `contracts/test/SeatEscrowV2Probes.t.sol`. Details: `contracts/README.md`.
- **The vault.** After the IMD developer said pairing accepts an ERC-1271 contract holder and pays the holder, `SeatVault` was built to hold one seat NFT per agreement, answer only owner-approved pairing digests and split every reward-token arrival by immutable terms. Rehearsed three times on Base Sepolia against mocks with a scripted, asserting walkthrough.

## SeatVault reviews (2026-09-28)

- **Round one (Codex).** Custody could strand the seat after a plain transfer and a provider `end()` (fixed: withdrawal relies on actual ownership and works after `end`); an unreadable or huge reward-token balance blocked withdrawal (fixed); approvals survived device changes and several coexisted (fixed: one active approval, cleared on device change, revoke, end and withdraw); a safe-minting registry could not deliver its agent token (fixed); operator key distinctness; pairing-script expiry recomputation and walkthrough guards (fixed). Reproductions: `contracts/test/SeatVaultReviewProbes.t.sol`, `test/pair-vault.test.mjs`.
- **Round two (Codex).** Malformed `balanceOf` return data still trapped the seat (fixed: withdrawal makes no call to the reward token at all); the walkthrough could execute one call twice by rebuilding with a fresh nonce (fixed: one signed transaction per call, same-bytes retries only, never rebuilt, receipt status required; every step asserts); the pairing script ignored IMD's code expiry and accepted fractional TTLs (fixed). Reproductions: `contracts/test/SeatVaultV2Probes.t.sol` and six more script tests. Codex also verified from the mainnet registry implementation that a contract caller is accepted for ERC-8004 registration.
- **Round three (Codex).** Three low script findings: a failed `cast nonce` read could continue as nonce zero, a status-1 receipt for another transaction hash was accepted, and token-id validation did not enforce the uint256 bound or the string transport type. All fixed the same day; Codex's regressions are kept under `test/codex/` and `contracts/test/codex/`, and the receipt and nonce fixes also have tracked tests in `test/pair-vault.test.mjs`. A second adversarial reviewer confirmed the three closed and added three low items (receipts must carry a block number; canonical decimal token ids; tracked regressions), applied the same day.
- **Verified locally after round three.** 67 Node tests, the 28-check self-test, the 12 round-three probes, 85 Foundry tests across 8 suites, `forge fmt --check` clean.

## Readiness reviews, the incoming-transfer fix and publication (2026-09-29)

- **Readiness reviews.** Codex and Claude independently reviewed the tree before any external submission. Both concluded: a contract-only review can proceed once the brief names one commit and a retrieval hash; a combined website review waits for one pricing rule and two fixes in the UI concept; real-seat use stays blocked on the unverified IMD behaviours listed in the brief. One demonstrated discrepancy: the escrow's incoming transfer helper checked only the contract's increase while its README claimed both sides.
- **Fixed with the owner's approval.** `_pullExact` now checks the sender's debit as well as the escrow's receipt; four regressions in `contracts/test/SeatEscrowV2Probes.t.sol` cover initial deposit, top-up, payFee and post-exit payShare with full rollback on rejection. The full Foundry suite passes 89 tests across 8 suites. The supported-asset assumptions remain necessary: balances must be honest and fixed outside transfers.
- **Prepared for publication.** The review brief was rewritten for the two contracts. The git history was rewritten to drop testnet deployment logs and one sentence with per-wallet payout totals, and the legacy simulation left the tree. A contract-only source archive with a manifest and SHA-256 is built from the committed tree by the local packaging script.

## What none of this establishes

These reviews and local tests do not constitute a production audit or establish live IMD compatibility. The reward figures above are three dated distributions, not an income schedule. Mock rehearsals on a testnet prove the scripted lifecycle, not acceptance by IMD or its payout routing.
