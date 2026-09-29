# Working in this repository

Seat Market is a prototype of two contracts for hosting an IMD seat NFT: a rental escrow (`SeatEscrow`) and an NFT-holding vault that enforces the reward split (`SeatVault`). Read `README.md`, then `contracts/README.md` and `contracts/VAULT-DESIGN.md` before changing behaviour. Nothing here connects a wallet, pairs a device, deploys to mainnet or pays anyone.

## Layout

- `contracts/` is the Foundry project: sources in `src/`, suites in `test/` (including the regressions adopted from each review round under their own files and `test/codex/`), testnet and pairing scripts in `script/`.
- `test/` holds the offline Node tests of the pairing helper and of the rehearsal script's send and receipt logic. They use fixtures and command shims; no key, network or chain.
- `docs/SWARM-REVIEW-BRIEF.md` is the brief for an independent review. `review/HISTORY.md` is the sanitized review chain; everything else that was ever under `review/` stays local by design (see `.gitignore`).

## Run and verify

```text
cd contracts && forge build && forge test && forge fmt --check src test script   # Foundry 1.8.3
npm test                                                                        # Node 22+; set REVIEW_PYTHON to a real Python 3 if discovery finds an alias
node contracts/script/pair-vault.mjs --selftest
```

CI runs the same commands on every push and pull request with read-only permissions and no secrets. Run them before and after any change.

## Rules

- Keep `contracts/README.md`, `contracts/VAULT-DESIGN.md`, `docs/SWARM-REVIEW-BRIEF.md` and `review/HISTORY.md` consistent with the code. State what was verified, by which method, and when. Do not describe the prototype as audited, production-ready or integrated with IMD.
- A reviewer's reproduction becomes a tracked regression once its finding is fixed; witnesses of intentional limitations are labelled as such.
- Distinguish dated reported behaviour (for example a developer's relayed statement) from independently verified behaviour.
- Scripts must never print or persist a private key, and their live modes stay off by default.

## Never commit

Credentials, tokens, keys, wallet addresses, worker or account configuration, deployment or broadcast output, raw review-run output, screenshots, source snapshots, or workstation paths. Stage by path and read `git diff --cached` before every push; the ignore file is a convenience, not a publication check.

## Outside this repository

Pairing, NFT transfers, payments, mainnet deployments, paid review submissions and any change to a live worker are separate actions that need the owner's explicit approval each time.
