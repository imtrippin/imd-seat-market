# Draft v1 deposit contract and evidence specification

2026-09-28 · Design draft supporting local prototype v0.3. No contract code or deployment. This specifies payment authority, not a claim that IMD's payouts or service are trustless.

## Scope and trust boundary

Owner holds NFT and receives IMD rewards directly. Provider supplies worker service. Escrow holds only voluntarily deposited collateral and provider payments. Neither participant can redirect IMD payouts through this contract. Provider cannot withdraw from the owner's wallet.

The elapsed-time minimum is calculable on-chain without a service oracle. It continues during downtime until either side ends. Owner attestation is required for a percentage share to encumber collateral; absent acknowledgment, the host can only draw the minimum. Off-chain observers and IMD standing do not create unilateral share-draw authority.

## Agreed state

Bind owner and provider addresses, unique agreement id, chain id, escrow contract address, reward asset address and decimals, source payer, dedicated receiving wallet, collection/token id, immutable daily minimum and required starting collateral, period duration, exit window, pricing rule version, selected service/profile digest and amendment nonces. Use actual token minor units in Solidity; DEMO's two decimals are not an IMD token specification.

Both participants approve the same terms digest before activation. Use typed signatures or explicit contract calls. Activation requires funded collateral and owner confirmation that the paired service is ready; a provider must not activate owner billing unilaterally. The local `pair` control represents this agreed activation, not a verified device operation. No NFT or wallet signing key belongs on a worker.

A single hosted NFT per dedicated wallet is a v1 onboarding rule. Holdings and transfers must be observed, and mixed rewards flagged; this is not guaranteed merely by declaring a wallet.

## Period accounting

Let `T0` be activation time, `D = 24 hours`, and `Tend` the earliest successful exit. Period k is `[T0 + kD, T0 + (k+1)D)`.

- `minimum[k] = floor(dailyMinimum × elapsedActiveSecondsInPeriod / D)`.
- `observedShare[k]` is off-chain informational debt from matching arrivals.
- `acknowledgedShare[k]` is the sum of the owner's accepted, unique attestations for that period.
- Informational entitlement is `max(minimum[k], observedShare[k])`.
- Collateral-authorized entitlement is `max(minimum[k], acknowledgedShare[k])`.
- Payments/draws credit a specific period. They cannot prepay future periods or be counted twice.
- Unpaid authorized debt is the sum of positive authorized-entitlement-minus-credited amounts per period.

Split amendments require both signatures and activate for subsequent arrivals, without resetting the period anchor. Deposit/minimum changes require a new agreement. Preserve old arrival splits. Grace arrivals use their arrival periods; minimum overlap after Tend is zero. This deliberately does not attribute airdrops to the work that earned them.

Worked example: 100 arrives during day 1 at 70/30; 14 later reward-free days at 2/day produce 30 + 28 = 58. A payout on day 2 does not erase day 1's minimum. Both sides must see this before approving.

The local model uses milliseconds and a deterministic +1ms action clock. The contract would use chain seconds and define same-block ordering precisely. Use period indices, bounded batch settlement and checkpointed minimum accrual so no withdrawal must loop over an unbounded agreement history. Gas bounds remain to be designed and tested before implementation.

## Operations and authority

| Operation | Caller / authority | Effect |
|---|---|---|
| Approve / amend split | Both parties | Exact terms/version digest; nonce-protected |
| Activate | Owner after bilateral terms and collateral | Sets T0 once; actual device pairing remains separate |
| Deposit / top up | Owner | Increases collateral; never automatically pays host |
| Acknowledge arrival | Owner signature or transaction | Adds unique arrival's share to its period; transfers no money |
| Pay provider | Owner | Funds claimable provider credits against period debt; never deposits owner's own reward share |
| Draw collateral | Provider | Moves only authorized unpaid entitlement, capped by reserve, into provider claim |
| Claim | Provider | Pulls funded claim; survives exit |
| End | Either participant | Fixes Tend, stops minimum, starts fixed exit window; does not revoke worker |
| Refund | Owner after window | Releases reserve beyond authorized unpaid debt |

Real owner payments require a distinction the local observer supplies for free: an on-chain contract cannot independently cap a payment against **unacknowledged observed debt**. Use an owner-signed period settlement/authorization with the payment, or restrict the contract payment route to acknowledged/minimum debt. The prototype's voluntary payment is an informational demonstration, not a claim that a contract can read Transfer history. Finalize this ABI choice before Solidity.

Direct transfers outside the escrow must not be silently treated as contract credits. Any import of external payment evidence needs a separate agreed receipt mechanism. Either route must prevent later collateral double-payment.

## Arrival attestations and replay protection

A production typed message must bind the agreement and rule version, chain id and verifying contract, token and source, receiving wallet, transaction hash and log index, finalized block identifier, arrival timestamp/period index, amount, assigned split version, signature nonce and expiry. Owner acknowledgment authorizes the share; it does not cryptographically prove the historical Transfer or IMD's work attribution. Reject duplicates across the agreement. Observed amount, shares and terms must be displayed before signing.

[EIP-712](https://eips.ethereum.org/EIPS/eip-712) supplies typed structured signing and domain separation; replay prevention still requires this application's unique arrival identities and nonce/consumption rules. No signature is collected by the prototype. Owner refusal remains possible and should trigger an alert/stop policy, not an unreviewed debit.

Only matching arrivals during activated service and before `Tend + 72h` qualify. An acknowledgment must reach the contract **strictly before the same deadline**. There is no extension for a last-minute arrival; a separate claim-submission window would be a different rule version. Once the window closes, no new share claim may encumber refundable collateral. Already authorized debt persists. Voluntary late settlement may pay the provider but must not create new collateral authority.

An observer should use finalized token Transfer evidence, exact chain/token/source/wallet checks, stable transaction/log identity, and explicit pending/reorg handling. The contract relies on owner assent, not observer trustlessness. The demo records no pending/reorg states. A fork/disputed-evidence policy remains necessary before live use.

## Exit, refunds and loss bounds

Developer chat, relayed by the project owner on 2026-09-28, says a paired NFT sale stops work/task acceptance and disconnects the server after roughly 30 minutes. This timing is not independently measured. Distinguish work eligibility, network connection, and escrow state. The demo ends the agreement in its transfer action, but a real sale does not send an escrow end transaction automatically. Owner/provider must end separately, or a separately specified ownership-change integration must do so. Do not wait 30 minutes to end billing, and do not declare a device disconnected from a timer alone. Keep a replacement seat blocked until observed disconnect under the conservative prototype policy.

Earliest exit wins; repeated requests cannot restart the grace clock. Minimum accrual stops immediately. Provider claims remain withdrawable; owner can refund only reserve beyond authorized unpaid debt after expiry. Unacknowledged observations cannot freeze funds indefinitely. Already drawn/claimed collateral cannot be recovered by merely revoking a device.

Owner's unilateral exposure to escrow draws is bounded by actual collateral contributed, including subsequent top-ups. This does not cap the total service obligation or voluntary payments. Provider's reserve protection is bounded by funded collateral and available authority. The one-day compute-loss target is an operational goal, not a guarantee: service-stop latency and future irregular reward claims can exceed it.

Use pull payments, checks/effects/interactions, reentrancy protection, exact token semantics and explicit unsupported-token behavior. No fee-on-transfer/rebasing assumption should be left implicit. Confirm the actual IMD token behavior and addresses before implementing or funding anything.

## Public evidence and host policy

The [IMD public API docs](https://imd.fun/docs/) document seat and device standing plus seat work records. Bind each sampled record to collection token, device public key, agreement and collection time. Reuse the existing watcher/cache where possible. Sample at a gentle documented cadence with backoff; do not add load tests or poll every NFT aggressively.

Presence and accepting-work status are distinct. A running job may still be valid service even if the device cannot accept another. A successful heartbeat is not verifier acceptance or payment. Keep raw public response evidence, collection timestamp, device mapping and unknown/error intervals. Define any advertised service-hour score from samples with explicit coverage thresholds; do not infer a full hour from one successful sample or count missing samples as offline.

For v1 this evidence supports review eligibility, human disputes and alerts. It does not alter the elapsed-time minimum automatically. Measured-uptime credits, oracle-authorized refunds or slashing would need separate agreement, authority, challenge and dispute rules.

A future host-side agent should request acknowledgment/payment/top-up, and stop accepting work when either the debt threshold or acknowledgment deadline is breached. Worker stop/restart behavior and in-flight-job handling must be approved and tested separately. The prototype implements only visible warnings.

## Remaining decisions before contract work

Finalize payment/attestation ABI and bounded period settlement; activation and amendment signatures; same-block ordering; token behavior; finality/reorg policy; transaction costs; service-failure remedy; acknowledgment latency alert and operational stop behavior. Obtain an independent implementation review before live funding. Public direct revoke and the spare-NFT transfer behavior remain separate IMD integration questions.

Revocation remains mechanism-neutral: the project owner noted that another route besides sale may exist. Present the user goal as “revoke hosting access,” and confirm IMD’s supported owner-authorized route before implementing it. Provider unlink and code-supported NFT transfer remain distinct alternatives; the sale report is evidence of ownership-loss behavior, not a requirement to sell the NFT.

## Implementation status (2026-09-28, revised the same evening)

**Decision (project owner): the contract is a rental with a security deposit, not the floor-and-acknowledgment design described above.** Listings set three numbers, a daily fee, a reward-share percentage and a deposit, any of the first two may be zero, and the parties choose the numbers rather than a formula. `contracts/src/SeatEscrow.sol` implements exactly that: bilateral approval of a digest derived on-chain from the money terms plus the document hash; owner-only activation gated on the deposit; a fee that accrues per second until either party ends; provider draws from the deposit and owner fee payments both capped by unpaid fee; voluntary, referenced share payments that never touch the deposit; immediate refund at exit of the deposit beyond unpaid fee; pull claims that survive exit; exact-amount transfer checks in both directions; 2^128 bounds on every amount. There are no periods, no acknowledgments and no exit window. The share is therefore honour-based and public, and the deposit protects the fee only, which is what the project owner asked for. Tests: unit, fee-clock fuzz, invariants and review probes in `contracts/test/`. Not deployed, not audited; see `contracts/README.md`. The floor-and-acknowledgment version was built, reviewed by Codex and fixed first (commits `8db325b`, `41af180`); it remains in git history should larger or performance-based rewards ever make the floor worth its complexity.

The prototype's JavaScript model (v0.3, per-period floor with acknowledgments) now describes a richer rule than the contract enforces and should be brought back to the rental rule so the site and the contract tell one story.
