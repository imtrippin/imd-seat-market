# Shared setup rooms

The setup room coordinates one existing vault. It adds no contract, money rule, wallet library or browser build step. It is a prototype tested against local Anvil and fake IMD, not a live IMD integration claim.

## Start and connect

1. Configure the chain and deployed factory in each console's ignored `config.json` as before.
2. Run `node rooms-server.mjs` on the machine providing the coordination service. Default: loopback port 18821, with appointments saved in ignored `data/rooms.json`.
3. Run `node server.mjs` for each participant's local console. Set both consoles' `setupUrl` to the same service origin.
4. Select the same vault. Use **Copy room link** to pass the vault identifier; the other person opens it against their own local console. The link carries no private key or room authentication token. A different local console port must be adjusted locally.
5. Join with the owner, provider or agreed operator wallet. The operator and provider both represent the host; only one active sign-in per role is retained. A newer sign-in invalidates the older one.

The service defaults to loopback. Remote use needs a separately operated HTTPS reverse proxy and reachable service, with `setupUrl` matching its external origin on the service and both consoles. `SETUP_HOST` and `SETUP_PORT` configure the service listener; never expose the signing console or move its operator key to the shared service. Deployment, TLS, backups and multi-instance storage are not implemented by this local build. This pass did not publish a service.

## User flow

- Scheduling is optional. Either participant can propose a time up to 30 days ahead; the other confirms the current version. Both see it in their own timezone. Changing a time clears readiness and requires fresh confirmation. An expired/past appointment can be replaced with **Connect now**.
- Calendar export creates a UTC `.ics` event with a ten-minute reminder. Import it into a calendar to obtain reminders while the console is closed. Silent in-page reminders require the page to remain open.
- Prepare the NFT deposit/sync before pairing. The owner checks the wallet network and needs gas; the host needs the agreed operator wallet or a matching local operator key. A preliminary zero-balance check is not a gas-cost guarantee.
- Presence expires after 45 seconds without a heartbeat. Hiding/closing the page clears manual readiness; reconnecting requires another ready click. Readiness also expires after ten minutes even if the page stays open.
- When both roles are ready, the host can request the code. Readiness is consumed once; concurrent starts cannot create two room attempts. The offer is shared to the owner automatically and revalidated locally.
- Both code and signature expiry clocks are displayed. The owner cannot build a fresh approval with less than 60 seconds remaining. Confirmation delays can still exhaust the window; this margin is not a confirmation-time guarantee.
- The host completes only after the exact approval is confirmed and the vault accepts the signature. Both clocks are checked again immediately before the IMD post. A timeout/error is not silently retried with a new code.
- Approval transaction hashes reported by the console are retained. A fresh attempt cannot discard an unresolved reported approval: inspect/resolve the wallet transaction first. The service cannot detect transactions never reported to it, or magically resolve a dropped/replaced transaction hash.

## Optional host automation

**Accept setup requests · 30 min** authorizes one pairing attempt for the selected vault only. It requires the matching operator key in the host's local console environment. The shared service never receives that key or the pairing signature.

The local server maintains its own host heartbeat, including when the browser is hidden or closed, until the 30-minute limit. It starts once the owner is ready, shares the challenge, waits for the matching owner approval, verifies the resulting signature on the vault, and completes. Success, expiry or an error disables the mode. **Stop automatic setup**, leaving the room, resetting, changing wallet/chain or selecting another vault cancels future steps. A request already sent to IMD cannot be recalled. Restarting the local process does not restore automatic authorization.

This is not a watcher that signs for every new marketplace listing or auto-discovers new vaults. The host first selects and authorizes this agreement. Extending this to a prepared listing needs explicit matching of the provider's advertised terms, device slot, operator and new vault before the same flow can be reused.

## Trust boundaries

- Sign-in message: fixed purpose, service origin, chain, vault, account, role, random nonce and two-minute expiry. The local console reconstructs the expected text before asking the wallet to sign; the relay cannot substitute arbitrary signing text.
- The room service reads the configured chain and vault terms to determine roles and checks the wallet signature. Its existing viem client verifies account signatures, including supported contract-wallet verification. Room tokens expire after an hour, stay in the local console's memory and never appear in browser state. Wallet-provider support for a particular multisig is separate from signature verification.
- Room data contains scheduling, reported presence, the public pairing challenge and transaction hashes. It never controls the immutable payout split, NFT custody, signing target or calldata. Each console still checks its own RPC/IMD data; the existing RPC and IMD trust assumptions remain.
- A malicious or unavailable coordinator can delay setup, misreport availability or withhold offers. It cannot substitute another vault/chain/device/relay in an accepted local pairing or grant the operator a valid signature without the owner's on-chain approval. It is not a service-quality oracle.
- The signing console rejects foreign `Origin`, non-loopback `Host`, and non-JSON mutations. The coordination service has no CORS or cookie-based authority. Session bearer tokens travel over HTTPS remotely, or loopback for local tests.
- This is a bounded single-process prototype (200 rooms, short-lived limited sign-in challenges, basic sign-in rate limiting). Availability/authentication are memory-only; appointments and attempts survive a service restart with everyone unready. Production operations and abuse controls need a separate deployment review.

- A vault whose owner is a contract (a multisig) cannot join a room yet: the sign-in must come from the owner address itself, and a multisig's signer key is not that address. Such owners use the manual offer strings; the console's own checks are the same on both paths.
- Behind a reverse proxy the sign-in rate limit keys on the proxy's address, so every client shares one bucket; honour `X-Forwarded-For` only from a proxy you operate. TLS terminates at that proxy; the service itself speaks plain HTTP.
- The room is optional: the console starts and completes a pairing without one, and the two offer strings remain the fallback.

## Verification

`npm test` includes authentication/replay, presence/expiry, schedule-version checks, concurrent start, unresolved-approval retry, offer binding/deadlines, restart, malicious sign-in text, cancellation, calendar and configuration cases. Two local consoles also run against real vault bytecode on Anvil and fake IMD: zero start calls before owner readiness, one shared offer, no completion before approval, one automatic completion afterward, and no operator key in shared state. The original creation-to-withdrawal rehearsal remains in the suite.
