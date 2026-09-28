# Response to Claude's v0.2 review — v0.3, 2026-09-28

Scope: local prototype only. Review source: Claude's v0.2 review, summarised in [the review history](HISTORY.md). That report, its original fuzz script and smoke screenshots are kept outside this repository, unchanged.

| Finding | Resolution |
|---|---|
| Exposure ignores unforwarded share | Model exports `unsecuredExposure` and `pauseRecommended`. All unpaid provider compensation minus remaining reserve drives the warning; zero-minimum offers warn on any positive exposure. Browser reproduced 20 owed / 20 exposure after a 10 draw. |
| Cumulative max prepays later floors | Adopted separate fixed 24-hour periods for this prototype iteration, anchored at service activation. Both parties see the worked 30 + 14×2 = 58 example before approval. An optional preference question was asked; no answer had arrived at implementation time. This is a prototype default, not a live agreed price. |
| Forwarding the whole arrival | Removed full-arrival forwarding and owner reward claims. Owner pays partial/full provider debt only. Deposits/top-ups are separate. Payment and reserve credit are tracked per period to prevent future minimums being silently prepaid. |
| Share draw authority | Exact owner acknowledgment authorizes the share; an observation alone cannot. Unacknowledged debt stays visible but cannot freeze collateral after the exit window. Minimum is elapsed agreement time, including downtime, not reported uptime. |
| Public service evidence | README and contract draft now identify documented seat/device standing and work routes. They describe sampled evidence, unknown intervals, device binding and gentle collection. No new live watcher or oracle is claimed. |
| Deposit/minimum amendments | Explicitly frozen for an agreement. UI approvals disclose that a new agreement is required to change these prices. Split amendments retain the billing anchor. |
| Text changes invalidate saved terms | Stable rule identifiers in the approved machine snapshot; explanatory text renders separately. Schema 4/new storage key intentionally does not reinterpret old cumulative/forwarding states. |
| Clock advances invisible elsewhere | A shared clock event is copied to every existing agreement's history, without adding time drift; restore permits only identical shared clock entries. |
| Example pricing versus observed income | README labels prices fictional and highlights that the minimum may dominate observed percentage earnings. Directory share labels no longer promise the owner necessarily keeps that net percentage. |

## Additional implementation choices

- Sharing begins at activation, after accepted terms and collateral. Pre-activation arrivals remain excluded. This avoids moving past arrivals between periods when activation happens later.
- Arrival and acknowledgment windows both exclude the exact `exit + 72h` deadline. A late arrival may leave little acknowledgment time. Already authorized debt persists; voluntary late payment remains possible. The final ABI must preserve this refund boundary.
- Payments and draws consume debt from the oldest eligible period. Paying an unacknowledged day-one share cannot consume a day-two minimum's deposit protection.
- Grace arrivals fall into their arrival periods, with zero minimum after exit; they do not retrospectively offset an earlier period's minimum.
- `CONTRACT-SPEC.md` is a draft, not Solidity. In particular, an on-chain provider-payment cap against unacknowledged debt needs owner-signed settlement data or a restriction to already authorized debt. The local observer's knowledge is not magically available to the contract.

## Developer clarification during this iteration

The project owner relayed that selling a paired NFT stops work and new task acceptance, with network disconnect roughly 30 minutes later. Added a separate `transfer-pending` state and explicit demo disconnect confirmation after a 30-minute clock advance. Billing/grace do not restart or extend while disconnect is pending; the seat remains reserved. Timing is labelled reported, not live-verified. Real sale and escrow exit remain separate operations.

## Validation

53 focused tests passed (49 model + 4 HTTP). A new v0.3 campaign adapted Claude's action-fuzz approach: 6,000 sequences / 105,958 applied actions over seeds 3 and 11, zero accounting-invariant or exact-restore failures. The campaign exercises acknowledgment, partial/full payments, authorized draws, refunds, amendments, transfer/unlink and multi-agreement clock changes. It preserves Claude's original v0.2 fuzz file; results are `fuzz-v03-seed-{3,11}.json`.

Browser checks covered the corrected 10-draw/20-payment flow, independent top-up, exit/refund, provider claim after exit, reload, dark/light mode, guide and 390/1440px layouts. Full details: [validation](../VALIDATION.md).

No live worker operation, NFT transfer, chain payment, external IMD write or publication occurred. The spare-NFT transfer test remains pending separate authorization.

Final static review: Claude Fable 5.1 found no blocker in the three approved source files; see `review/claude-v03-bounded.md` in the prototype. It traced period credits, acknowledgment cutoff, refunds, restore and delayed disconnect. The initial broader attempt timed out without a report. Minor display/timestamp/form-guidance consistency updates followed, and all 53 tests pass. Final source hashes are in `review/v03-final-source-manifest.json`.
