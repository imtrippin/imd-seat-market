# Review history

A sanitized summary of the review chain behind this prototype, so the repository is self-contained. The full reports, raw review-run records, source snapshots and screenshots are kept outside the repository, unchanged. Dates are 2026-09-28 and times are UTC unless stated.

## Who did what

- **Codex** built v0.1 (work-receipt model), v0.2 (collateral and arrival-time model) and v0.3 (per-period accounting, owner acknowledgment, draft contract specification) and wrote the responses.
- **Claude (Fable 5.1)** reviewed each version: two static reviews of v0.1's three source files with tools disabled, a workspace review of v0.1's trust model against public chain and worker evidence, a static collateral review plus a workspace review of v0.2 with a fuzz campaign, and a bounded static review of v0.3.

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
- **Findings, with the v0.3 resolutions** (details in `V03-RESPONSE.md`): the exposure warning ignored the unforwarded share (fixed: full-debt exposure in model and UI); a cumulative max let one payout pre-pay later floors (changed to fixed 24-hour periods anchored at activation); forwarding the whole arrival did not match the real flow (replaced by provider-only payments and separate top-ups); a deposit contract can enforce the time-based minimum without an oracle but not the share (owner acknowledgment now authorizes share draws); IMD's public seat and device standing routes are usable service evidence (documented, no watcher wired in); amendments cannot change deposit or minimum (now explicit); terms-text edits invalidated saved data (stable rule identifiers); clock advances were invisible to other agreements (shared clock events).

## v0.3 bounded static review

- **Scope.** `dist/app.js`, `dist/model.js` and `server.mjs` with tools disabled and no internal documents, at these SHA-256 hashes: app `3a6623b443b1c66e0429d07fd41684a8c2ee2630f18b0adc4edc3d3b6f545065`, model `c9a337e0fadc55d4b6b15166b71c5764e0593ca98fd0039c45467f76d793c841`, server `6fc5b5a3455d71f34680cde4b5b0f42639a43493ab54c1028103ad452db810ff`. Report: `claude-v03-bounded.md`.
- **Verdict.** No blocker in per-period accounting, owner-only acknowledgment, refunds after the cutoff, or restore consistency. Four non-blocking display and form observations, plus the production prerequisites listed in the report.
- **After the review.** Codex changed display, timestamp and form-guidance details only. The committed sources are the hashes in `v03-final-source-manifest.json`. On the committed tree the 53-test suite and both fuzz seeds (105,958 applied actions) pass; the CI workflow repeats those checks.

## SeatVault round-three review and fixes (2026-09-28)

- **Reviewed.** Codex checked the round-two fixes on tree `9c8f4c1`: no new custody or reward-accounting bug; the direct `ownerOf` + `safeTransferFrom` withdrawal path was confirmed against the collection's verified source; settlement rounding was quantified (provider allocation never below `floor(x·p/B)`, batching changes it by at most one base unit per merged chunk). Three low-severity script findings with reproductions: a failed `cast nonce` read could continue as nonce zero (Foundry 1.8.3 signs an empty `--nonce` as 0), a status-1 receipt for another transaction hash was accepted, and token-id validation did not enforce the uint256 bound or the string transport type.
- **Fixed, same day.** `contracts/script/testnet-walkthrough.sh`: the nonce read is checked for exit status and shape and stops the caller; receipts must match the local hash, be mined and have status 1, a mismatch is reported as ambiguous (code 3) and never rebuilt; the at-most-once claim is scoped to one `send` invocation. `contracts/script/pair-vault.mjs`: token ids must be decimal strings within uint256; the completion body names every field explicitly and sends the id as a string. Codex's regressions are kept under `test/codex/` and `contracts/test/codex/`.
- **Re-checked.** A second Claude reviewer (adversarial) confirmed the three closed and added three low items, applied the same day: receipts must carry a block number; token ids must be canonical decimals (`007` refused, the CLI too); and the receipt/nonce regressions now live in the tracked suite (`test/pair-vault.test.mjs`, using the real Python parser when one is available), not only in the round-three probes.
- **Verified locally.** 67 focused tests (2 new), the 28-check self-test, Codex's 12 round-three probes (all four intended failures now pass), 85 Foundry tests across 8 suites, `forge fmt --check` clean. Details and the worked pricing example: `claude-response-codex-vault-v3-2026-09-28.md` (local).
- **Not changed.** Contracts, both UI versions, and the VAULT-DESIGN wording items from the review (queued). The live IMD integration prerequisites are unchanged and still unverified.

## What none of this establishes

Static reviews and a JavaScript fuzz do not audit a contract that does not exist yet. Role switching is unauthenticated, acknowledgments are checkboxes rather than signatures, and arrivals, transfers and disconnects are simulation controls. The reward figures above are three dated distributions, not an income schedule.
