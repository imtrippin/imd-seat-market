# Swarm review brief (draft, not submitted)

Purpose: an independent review of Seat Market by IMD swarm workers. The first substantial target is the **first locally tested contract and wallet integration**, once it exists. Until then a review can examine design and model correctness only, because there is no Solidity to review.

This is a template. Fill in the commit and retrieval method at submission time. Submitting a quote or a paid job is a separate, explicitly approved step.

## Binding

- Repository: `<url>`. Commit: `<full sha>`. Reviewers must state the commit they read and must not review a different one.
- Retrieval: the repository is private, so reviewers cannot fetch it as-is. Choose one before scheduling: publish the repository or a mirror at that commit, or attach a source archive as job input and state its SHA-256 in the brief. Never put credentials, tokens or private links in a job prompt or input.
- In scope: `dist/model.js`, `dist/app.js`, `server.mjs`, `test/`, `review/fuzz-v03.mjs`, `CONTRACT-SPEC.md`, and the contract sources plus integration tests once they exist.

## Requested work

1. **Accounting.** Conservation of deposits, payments, draws, claims and refunds; partial payments; period boundaries at activation, amendment and exit; collateral exhaustion; double payment; stranded funds that no party can ever withdraw.
2. **Authorization.** Exact-terms approvals; signature replay; nonces; domain separation; amendment ordering; third-party access once signatures exist.
3. **Adversarial lifecycle.** Owner refusal to acknowledge or pay; host downtime; late arrivals near the exit deadline; deadline ordering in the same block; ownership changes; exit and refund races.
4. **Interface accuracy.** Whether displayed balances, permissions, stop states and claims match actual contract behaviour.

## Finding format

Every concrete finding must include: severity (blocker, high, medium, low); the exact file and function; a reproducible action sequence or a failing test; impact; a suggested fix. Separate demonstrated bugs from design trade-offs and from unimplemented production prerequisites. Several reviews agreeing is not proof of safety.

## Deliverables

- A Markdown report.
- A machine-readable findings list (JSON) with the fields above, the commit reviewed, and the commands run with their output.

## Out of scope

Live pairing, NFT transfers, payments, worker changes, and any action against a live IMD deployment.
