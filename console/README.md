# Seat console

A local page for one hosting agreement, used by the NFT owner and the host. The page reads the agreement from the chain and IMD's public API, tells each role what to do next, and asks the connected wallet to sign exactly the call it shows. A separate setup-room service shares appointments, readiness and the pairing offer. Console sessions and room appointments are saved locally; availability and room sign-ins expire.

```
cd console
npm install
copy config.example.json config.json    # fill in the factory address for your chain
npm start                                # http://127.0.0.1:18820/
```

Or double-click `start.cmd`. The server binds to loopback only. It reads the chain through `rpcUrl` and IMD through `imdApi`, and proxies the few IMD calls a browser could not make cross-origin. The page has no dependencies and loads no third-party script.

For coordination, run `npm run rooms` (or `node rooms-server.mjs`) in a second terminal. It defaults to loopback port 18821. For two machines, configure both consoles with the **same** reachable HTTPS `setupUrl`; two separate localhost services do not communicate. The shared service has its own copy of the chain configuration, holds no signing keys, and is separate from the loopback signing console. See [SETUP.md](SETUP.md) for operating limits and the protocol. Nothing is published or deployed by these commands.

## Roles

Connect a wallet; the console tells it apart by the vault's terms: **owner** (the wallet that created the vault and holds the seat), **host** (the provider address that receives the host share), **operator** (the key that signs pairings). Anyone else is a viewer. Two people on two machines can each run their own console pointed at the same vault.

The host gives the owner a **hosting offer** (`seathost1:…`, provider, operator, worker device key, share) before the vault is created. During pairing the host's console produces a **pairing offer** (`seatpair1:…`, IMD's challenge for one attempt). With a shared setup room (optional, see `SETUP.md`) the offer reaches the owner automatically after a scoped, gas-free wallet sign-in; without one, the host sends the string by any channel and the owner pastes it. Both paths run the same local validation, and a room sign-in cannot authorize a transaction or a pairing.

## The flow

| Step | Who | What happens |
| --- | --- | --- |
| Create the vault | owner | One transaction to the factory with the host's offer and the seat id. The console picks the new vault up from the `VaultCreated` event. |
| Deposit the seat | owner | Approve the vault for the token, then `deposit()`. A plain transfer works too, followed by `syncHeld()`. |
| Get ready (optional, with a setup room) | both | Connect now or propose a local-time appointment and have the other party confirm it. Join the same setup room and confirm readiness after the NFT is deposited. Calendar export and silent in-page reminders are available. |
| Pair the host's worker | host, owner, host | The host requests a fresh code (`POST /pair/start`, five-minute life): in a room only once both are ready, otherwise whenever the host chooses. The offer reaches the owner through the room or by hand. The owner approves that exact digest on the vault; the host completes after confirmation. Both code and signature deadlines are visible. The console checks ERC-1271 and both deadlines before posting completion. |
| Register the agent | owner | The console fetches `GET /agents/register-intent`, checks it targets the pinned registrar and names this seat, and the owner sends it through `registerAgent`. The agent id comes from the event; the console then calls `POST /agents/bind`. |
| Hosting | both | Rewards arriving at the vault show as unsettled; anyone settles, each party claims its own share. |
| Exit | owner | `withdrawNFT` returns the seat and ends the agreement; rewards already in the vault stay claimable. |

## Signing the pairing

The operator key lives with the host. Either run the host's console with `OPERATOR_KEY=0x…` in the environment (the key signs the pairing digest and nothing else; it never sends a transaction and is never printed), or connect the operator's wallet to the page and sign the typed data there (`eth_signTypedData_v4`, domain `IdentityMD Worker` v2, verifying contract = the seat collection). In both cases the console first asks the vault whether it accepts the signature before anything goes to IMD.

## Configuration

**Optional automatic setup:** after joining the selected vault's room with the local operator key configured, the host can enable **Accept setup requests · 30 min**. For one attempt, the local server waits for the owner's readiness, requests the code, waits for the matching on-chain approval, and signs/completes. It stops after success, expiry or error. Stop/leave cancels future steps; an already sent request cannot be recalled. This is per agreement, not an unattended marketplace-wide listing watcher. No code starts just because an owner browses a listing. Manual signing still works when the host has no local operator key.

`config.json`: `chainId`, `rpcUrl` (a public RPC for reads), `imdApi`, `factory`, `collection`, `rewardToken`, `registrar`, `relayOrigin`, optional `explorer`, `rewardSymbol`, `rewardDecimals`, `pollMs`, `imdPollMs`, `setupUrl`. The example pins IMD's mainnet collection, token and registrar; the factory address is filled in once it is deployed. The console refuses a vault whose collection is not the configured one, a pairing offer for another vault, chain or relay, and a register-intent that does not name this seat.

## Tests

`npm test` runs the unit tests (pairing payloads, offer strings, the step machine) and an end-to-end test that starts a local anvil chain with the real vault and factory bytecode, a fake IMD that verifies pairings through the vault's `isValidSignature`, and the console itself, then walks one agreement from creation to exit the way the page does. The end-to-end test skips when anvil or the Foundry artifacts (`forge build` in `contracts/`) are missing.

## What it does not do

It does not hold the owner's key and does not run the host's worker. Its state-changing IMD calls are pairing start, pairing completion and agent bind. The local operator key must remain separate from the worker device key. Setup reminders are in-page only; calendar export lets the user's calendar supply reminders when the page is closed. No Telegram, email, audio or browser push is used. Whether IMD's relay, bind and payout routing behave as documented for a contract holder is exactly what the first live rehearsal establishes.
