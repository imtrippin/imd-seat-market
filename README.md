# Seat Market — local prototype v0.3

NFT owners compare worker hosts, negotiate reward splits, fund refundable collateral, and review service. Run `start.cmd` or `node server.mjs`, then open **http://127.0.0.1:18816/**. Node 22+, no install or build step.

**Fictional, local simulation.** No wallet, real IMD tokens, deployed contract, live pairing, worker control or verified advertising is connected. Switching roles is a test control, not authentication. Dark mode persists.

**Scope of this page.** It describes the JavaScript simulation and its v0.3 per-period model. The on-chain contracts, the rental escrow (v2) and the seat vault, live in `contracts/` with their own README and design note; the simulation's model has not yet been realigned to the rental rule.

Use **Look & feel** to compare Control room, Paper ledger, Terminal and the original design. All support light/dark mode; appearance preferences are separate from agreement data. See [visual directions and preview links](docs/VISUAL-DIRECTIONS.md).

## Today's payment flow

IMD pays the NFT owner wallet, as confirmed by the project owner and the dated mainnet evidence summarised in [the review history](review/HISTORY.md). The owner keeps its rewards there and pays only the provider's compensation. An observed arrival records an obligation; it neither funds a claim nor gives a contract authority over the owner's wallet.

The provider can claim funds received through provider payments and authorized deposit draws. There is no owner reward claim in the app. The owner can refund unused collateral after settlement. Future delegated payout routing is optional future work, not an assumed capability.

## Billing and refundable collateral

The deposit addresses taking compute and moving to another provider without paying. A percentage of zero rewards offers no protection, so a provider may also advertise a minimum.

**For each fixed 24-hour period: provider earns max(covered arrival share, prorated elapsed-time minimum). Total compensation is the sum of those period amounts.**

Periods start at service activation and do not reset when the split changes. A partial final period's minimum rounds down to minor units. Reward-share rounding sends the remainder to the provider. Each arrival belongs to its arrival period, not to an inferred job or earning period. A later grace-period arrival does not offset the minimum of an earlier period.

Example: 70/30 split, 2/day minimum, 100 received during the first day. Day 1 earns 30. Fourteen later zero-reward days earn 28 more: **58 total**, not 30. If an arrival instead lands in day 2, the zero-reward first day still earns its own minimum. Irregular airdrops make this distinction material.

This is **elapsed agreement time, including downtime**, from activation until either party ends. A contract can calculate that minimum without an uptime oracle. It does not prove that service was delivered. The owner needs to monitor and end promptly if service fails; the host must stop promptly after exit. A contract's unilateral draw is limited to its funded deposit; additional top-ups expose additional funds. Measured-uptime billing would require a different evidence and dispute design.

### What each action does

1. Both sides approve the exact terms. Owner funds the required collateral before activation.
2. Matching rewards arrive in the owner wallet. Their share is recorded as owed, not funded.
3. Owner may **pay** part or all of the outstanding provider compensation. Payments credit the oldest unpaid periods and cannot prepay future periods. Owner rewards never pass through the escrow for redistribution.
4. Owner may separately **acknowledge** an exact arrival and assigned share. This gives the provider authority to draw that period's unpaid share from collateral. It transfers no funds. The demo acknowledgment is a local role action, not a cryptographic signature.
5. Provider may **draw** the unpaid elapsed minimum or acknowledged share, whichever is greater in each period, capped by the remaining deposit. Payments and draws credit the same period; the host is never paid twice.
6. **Top-ups are separate** owner deposits; provider payments do not replenish collateral automatically.
7. Either party may end. Before the exclusive `exit + 72h` deadline, covered arrivals and owner acknowledgments remain possible. After that deadline, owner refunds unused collateral, preserving authorized unpaid debt. Unacknowledged claims cannot freeze refunds. Owner may still pay observed debt voluntarily after the deadline.

Refusing acknowledgment remains a real trust risk. The deposit protects the elapsed minimum and acknowledged shares up to the funded balance; it cannot force the owner to acknowledge rewards or capture rewards sent to a new wallet.

### Exposure and pause policy

`unsecuredExposure = max(0, all unpaid provider compensation - remaining collateral)`.

This includes the percentage share. The UI recommends a pause at one daily minimum of exposure, or any positive exposure for a zero-minimum offer. It separately shows share debt that lacks draw authority even when collateral exists. A real host policy should also require timely acknowledgment; a deposit balance alone is not sufficient protection.

**One unpaid day remains a risk target, not a guarantee.** No worker is paused by this prototype. Observation delay, service-stop delay, irregular payouts and unacknowledged percentage upside can exceed that target. Prices are fictional. Claude's dated review reports per-agent rewards around 7.7, 3.05 and 3.12 IMD in three September distributions; those are distributions, not established daily income. At such amounts, a 2/day minimum can dominate a 30% share. Do not use the large 100-DEMO lifecycle example as an earnings forecast.

## Provider advertising and terms

Profiles advertise introduction, region, shared vCPU/RAM/disk, seat slots, skills, runtime, selectable LLM options, AI access arrangement, maintenance/support commitments, split, deposit and minimum. Owners can filter by runtime/skill and inspect the profile before proposing terms. Capacity, identity and skill claims are unverified.

The approved snapshot binds machine/skill/service claims, selected LLM, wallet, asset/source, split, collateral and stable machine-readable rule identifiers. Explanatory UI prose is separate from those identifiers. Split-only amendments require both approvals and affect subsequent arrivals; they do not reset periods. Changing the deposit or minimum requires a new agreement. AI permission, quotas and account access need separate agreement; do not submit keys, tokens or authentication files here.

## Arrival and exit rules

- **One hosted NFT per dedicated receiving wallet**, no mixed seats or unrelated eligible rewards. This is a v1 attribution constraint because historical rewards have been aggregated at wallet level. The demo verifies only fictional labels.
- Coverage begins after terms acceptance **and service activation**. Pre-activation arrivals stay excluded.
- Matching payer, asset and wallet arrivals use the split accepted at arrival. The simulation has one fixed DEMO asset; a real observer must check chain and token too.
- After exit, the final split covers matching arrivals strictly before `exit + 72h`. Acknowledgment must also be received before that deadline. An arrival just before the deadline can leave little acknowledgment time; this is a disclosed limitation, not a promised payout schedule.
- Moving the NFT can change its future reward destination; the old wallet's rule cannot capture those new-wallet funds.

Ending the agreement stops minimum accrual but does not itself revoke the device. Mock host unlink ends participation and revokes in the simulation. Owner transfer ends the demo agreement and enters a separate work-stopped/disconnect-pending state. The pinned worker code treats `nft_transferred` as terminal and reports moved NFTs stale, and the project owner relayed the developer’s clarification on 2026-09-28: when a paired NFT is sold, the server stops working and accepting tasks, then disconnects after roughly 30 minutes. This is a developer report, not independently measured timing. The **live spare-NFT transfer test remains pending explicit authorization**. ERC-8004 agent-ID continuity and moving the token back remain unresolved. A direct wallet-signed revoke route is still unverified. The demo uses a 30-minute advance plus explicit simulated disconnect confirmation, keeping the seat/capacity reserved until confirmation. A real integration must observe the disconnect instead of assuming it from a timer. A real sale does not itself submit an escrow exit: end the hosting contract separately to stop elapsed-time billing. No live worker was changed.

## Public service evidence and reviews

The [IMD API documentation](https://imd.fun/docs/) documents `/seats/:tokenId/standing`, `/workers/:deviceKey/standing` and `/seats/:tokenId`. A watcher can collect presence, accepting-work state, device binding, timestamps and work results. Prefer existing watcher records and gentle polling; missing samples are unknown, not evidence of downtime. Presence does not establish accepted work or payment.

That evidence can support reviews, pause alerts and disputes. It is not automatically a trustless contract input. No standing watcher is wired into this local app. See [the draft contract and evidence specification](CONTRACT-SPEC.md) for the distinction between elapsed-time billing and measured service evidence.

An owner can review after accepted terms and pairing plus either a covered arrival during service or 24 paired hours. Payment and provider approval are not required; post-exit time cannot fabricate eligibility. Production reviews need historical owner authentication, independent usage evidence, duplicate/Sybil controls and edit/reply history.

## Try the corrected lifecycle

Load **My agreements → Load lifecycle example**. It has a 10-DEMO deposit and a 100-DEMO arrival halfway through the first day; the clock ends at 24 hours. Provider compensation is 30, of which only the minimum 2 initially has draw authority.

1. As owner, review and acknowledge the arrival. Provider draw authority becomes 30.
2. As host, draw 10 from the deposit, then claim. The UI shows deposit 0, unpaid compensation 20, unsecured exposure 20 and a pause recommendation.
3. As owner, pay 20. Provider can claim that 20; deposit stays 0. Top up 10 separately.
4. End or simulate transfer-revoke before advancing more days. For transfer, advance 30 minutes and confirm disconnection in the demo. After the 72-hour window refund the unused 10. Already funded provider claims survive exit.
5. Try declining acknowledgment instead: the host can draw only its minimum. At expiry the unused deposit can be refunded, while the observed unpaid share remains visible and voluntarily payable.

## Implementation and validation

- `dist/model.js`: immutable transitions, per-period integer ledger, approval/acknowledgment boundaries, exposure helpers and restore validation.
- `dist/app.js`: responsive light/dark UI and optional WebMCP tools. `dist/styles.css`, `dist/index.html` provide layout.
- `server.mjs`: loopback-only allowlisted GET/HEAD server, no write API, CSP disallows external app connections. Override port with `SEAT_MARKET_PORT`.
- `node --test test/model.test.mjs test/server.test.mjs` runs focused checks. Randomized campaign: `node review/fuzz-v03.mjs 3` and seed `11`.
- Schema 4 uses `seat-market.local.v4`. Old v2/v3 keys are left intact, not reinterpreted under changed economics. Cross-tab updates close stale dialogs; stale writes are rejected. This is not an atomic multi-user database.
- Global clock advances are recorded in every existing agreement history.
- [Review history](review/HISTORY.md), [v0.3 response](review/V03-RESPONSE.md), [validation](VALIDATION.md). Earlier review reports, source snapshots and raw review-run records are kept outside this repository; the history file summarises them and records the reviewed source hashes.

A production deposit contract is a feasible separate next implementation, subject to the detailed specification and testing. No Solidity is written or deployed by this iteration. Future lockable per-seat payout routing or EIP-1271 NFT-vault pairing would require IMD support; a plain splitter only divides funds it actually receives.

Revocation remains mechanism-neutral: the project owner noted that another route besides sale may exist. Present the user goal as “revoke hosting access,” and confirm IMD’s supported owner-authorized route before implementing it. Provider unlink and code-supported NFT transfer remain distinct alternatives; the sale report is evidence of ownership-loss behavior, not a requirement to sell the NFT.

## Repository

Private repository. CI runs the focused tests and both fuzz seeds on every push and pull request with read-only permissions and no secrets. Contributor and agent guidance is in `AGENTS.md`; a draft brief for a later independent review is in `docs/SWARM-REVIEW-BRIEF.md`. No license is granted yet.
