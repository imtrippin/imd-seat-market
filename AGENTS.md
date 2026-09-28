# Working in this repository

Seat Market is a **local simulation** of a hosting marketplace for IMD NFT seats: owners keep the NFT and its rewards, providers run the worker, and a refundable deposit plus a per-period minimum bound the provider's trust. Nothing here connects a wallet, a chain, a deployed contract, live pairing or worker control. Read `README.md` for the product rules and `CONTRACT-SPEC.md` for the draft contract authority model before changing behaviour.

## Layout

- `dist/` is hand-written source, not a build output. `dist/model.js` holds every state transition; `dist/app.js` is the UI; `server.mjs` is the loopback preview server.
- `test/` holds the focused suite. `review/fuzz-v03.mjs` is the randomized invariant campaign; its two recorded results and the reviews the docs cite live beside it. Everything else that was ever under `review/` stays local by design (see `.gitignore`).
- `docs/SWARM-REVIEW-BRIEF.md` is a draft brief for a later independent review. It is not submitted anywhere.
- `contracts/` is the Foundry project for the on-chain escrow (`contracts/README.md`). It is a separate build with its own tests; the JavaScript model and the contract must keep telling the same story about what is enforceable.

## Run and verify

```text
node server.mjs                 # http://127.0.0.1:18816/  (loopback only, no build step, Node 22+)
npm test                        # 53 focused tests
node review/fuzz-v03.mjs 3      # randomized campaign, seed 3
node review/fuzz-v03.mjs 11     # randomized campaign, seed 11
cd contracts && forge build && forge test && forge fmt --check src test script   # the escrow (Foundry 1.8.3)
```

CI runs the same commands on every push and pull request with read-only permissions and no secrets. Run them before and after any change to `dist/model.js` or the tests.

## Rules that keep the model honest

- Transitions are immutable and integer-only. Every successful transition must restore byte for byte through `restoreState`; the fuzz asserts this after each action.
- The rule identifiers bound into approved terms are separate from explanatory prose. If you change what a term means, bump the storage schema and key instead of reinterpreting saved data.
- Keep `README.md`, `CONTRACT-SPEC.md`, `VALIDATION.md`, `review/V03-RESPONSE.md` and `review/HISTORY.md` consistent with the code. State what was verified, by which method, and when. Do not describe the prototype as production, audited or ready for a testnet.
- Distinguish dated reported behaviour (for example a developer's relayed statement) from independently verified behaviour.

## Never commit

Credentials, tokens, keys, wallet addresses, worker or account configuration, raw review-run output, screenshots, source snapshots, or workstation paths. Stage by path and read `git diff --cached` before every push; the ignore file is a convenience, not a publication check.

## Outside this repository

Pairing, NFT transfers, payments, paid review submissions and any change to a live worker are separate actions that need the owner's explicit approval each time.
