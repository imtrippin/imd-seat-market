# Validation — Seat Market v0.3 — 2026-09-28

Runtime: Node v22.11.0, Windows, plain HTML/CSS/ES modules, zero runtime dependencies. Preview http://127.0.0.1:18816/. Prior v0.2 validation is summarised in `review/HISTORY.md`; its forwarding/cumulative-max economics are superseded.

## Focused checks

`node --test test/model.test.mjs test/server.test.mjs`: **53 passed, 0 failed** (49 model, 4 HTTP).

Checks include bilateral exact approval; counterproposals; split/version boundaries; fixed 24-hour periods and partial final minimum; day-one 30 plus 14 days at 2 totals 58; before-activation exclusion; grace deadline and late voluntary payments; partial provider-only payments and overpayment rejection; no owner claim; independent collateral top-ups; period-local payment credits; role/exact-arrival/deadline-bound acknowledgments; observation not conferring draw authority; safe refund with/without acknowledgment; complete exposure and zero-minimum pause; claims after exit; dedicated wallets; owner transfer and host unlink; reviews without payment; profile snapshots; shared clock events; exact restoration and rejection of forged accounting fields.

HTTP checks cover loopback serving, CSP, HEAD, private-path allowlist, rejection of writes and malformed-URL resilience. Existing local server remained running; it serves current files. No live worker process was touched.

## Randomized model campaign

`node review/fuzz-v03.mjs 3` and `node review/fuzz-v03.mjs 11`.

| Seed | Sequences | Applied actions | Invariant / restore failures |
|---|---:|---:|---:|
| 3 | 3,000 | 53,049 | 0 |
| 11 | 3,000 | 52,909 | 0 |
| Total | 6,000 | 105,958 | 0 |

Checks actual-money conservation, nonnegative funded balances, owner claim always zero, no period prepayment/host overpayment, draw authority, refund reservation and timing, minimum stopping at exit, exposure arithmetic and byte-for-byte restoration after every successful action. Runs include shared clock events across multiple agreements. Results are in `review/fuzz-v03-seed-3.json` and `review/fuzz-v03-seed-11.json`. The script adapts Claude's v0.2 action-fuzz idea but uses the new ledger, a seeded integer PRNG and non-tautological refund assertions. This is not a formal proof or a contract audit.

## Browser checks

Used actual in-app browser UI controls against the local preview:

- New schema loads without overwriting prior schema-3 data. Loaded example displays 30 owed, 2 minimum authorized and 28 needing owner acknowledgment.
- Acknowledgment dialog shows exact arrival identity, timestamp, payer, wallet, amount and share. Acknowledging creates no funded claim.
- Provider draws 10: reserve 0, claimable 10, unpaid 20, exposure 20, pause recommendation visible. This directly reproduces and fixes Claude's reported UI defect.
- Provider claims 10. Owner payment form defaults to the outstanding 20; payment funds provider claim 20 without an owner claim or automatic top-up.
- Separate owner top-up restores reserve 10. The initial smoke used mock transfer exit, three clock advances and a refund of unused 10. The subsequent developer clarification added a distinct pending-disconnect stage; its additional verification is recorded below.
- Reload restores the completed state without a fallback/reset warning. Provider can still claim its funded 20 after exit; claim then becomes zero.
- Mobile agreement and light-mode guide: 390px viewport, document/body width 375px, no page overflow. The wide data table scrolls within its panel.
- Desktop agreement: 1440px viewport, document width 1425px, no page overflow. Dark mode restored after checking light mode.
- Browser warning/error log was empty for the checked flow. Temporary viewport override is reset before handoff.

Developer-clarification follow-up: transfer enters work-stopped/disconnect-pending, survives reload, and disables confirmation until the demo advances 30 minutes. Advancing time alone leaves it pending. Explicit confirmation changes it to disconnected and survives reload, with minimum still 2.00 and no console errors. The focused suite rejects premature/incorrect-role confirmation, preserves grace and billing endpoints, and blocks rehosting while pending. The repeated randomized campaign includes 1,128 successful disconnect-confirmation actions.

No real wallet authentication, cryptographic attestation, IMD arrival observer, standing watcher, service measurement, deployed contract, automatic host stop or live revocation was tested.

## Review status

Claude Fable 5.1 completed a tools-disabled static review of the three previously authorized files (`dist/app.js`, `dist/model.js`, `server.mjs`) and found **no blocking issue** in the four focus areas. See `review/claude-v03-bounded.md`; the reviewed file hashes are recorded in `review/HISTORY.md`, and the final committed source hashes in `review/v03-final-source-manifest.json`. The first broader attempt timed out at eight minutes with no report; the focused retry completed in 253 seconds. No internal project documents were supplied, and `--safe-mode` disabled CLAUDE.md and customizations.

After review, the minimum card was aligned directly with the period-table sum, refund amount calculation was aligned with the event timestamp, and listing forms gained the model’s skill/LLM bounds in their guidance. The reviewed model already included the developer-reported pending-disconnect flow. Later copy explicitly separates escrow exit from NFT sale and keeps other revoke routes open. The final 53-test suite passes. The server’s index references were checked locally and point to `/app.js` and `/styles.css` as required. This was static review, not a production audit.
