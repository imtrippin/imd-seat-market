# Seat console

A local page for one hosting agreement, used by the NFT owner and the host. Both see the same thing because nothing is stored here: the page shows what the chain and IMD's public API say about the vault, tells each role what to do next, and asks the connected wallet to sign exactly the call it shows.

```
cd console
npm install
copy config.example.json config.json    # fill in the factory address for your chain
npm start                                # http://127.0.0.1:18820/
```

or double-click `start.cmd`. The server binds to loopback only. It reads the chain through `rpcUrl` and IMD through `imdApi`, and proxies the few IMD calls a browser could not make cross-origin. The page has no dependencies and loads no third-party script.

## Roles

Connect a wallet; the console tells it apart by the vault's terms: **owner** (the wallet that created the vault and holds the seat), **host** (the provider address that receives the host share), **operator** (the key that signs pairings). Anyone else is a viewer. Two people on two machines can each run their own console pointed at the same vault.

The host gives the owner two short strings, by any channel: a **hosting offer** (`seathost1:…`, who the host is: provider, operator, worker device key, share) before the vault is created, and a **pairing offer** (`seatpair1:…`, IMD's challenge for one pairing attempt) during pairing. The console validates both against the pinned chain, relay and collection before using them.

## The flow

| Step | Who | What happens |
| --- | --- | --- |
| Create the vault | owner | One transaction to the factory with the host's offer and the seat id. The console picks the new vault up from the `VaultCreated` event. |
| Deposit the seat | owner | Approve the vault for the token, then `deposit()`. A plain transfer works too, followed by `syncHeld()`. |
| Pair the host's worker | host, owner, host | The host asks IMD for a pairing code (`POST /pair/start`, five-minute life) and hands the owner the pairing offer. The owner approves that exact digest on the vault. The host completes: the operator key signs, the console checks the vault answers valid (ERC-1271) and posts `/pair/complete`. Then it watches the seat's standing until the device shows. |
| Register the agent | owner | The console fetches `GET /agents/register-intent`, checks it targets the pinned registrar and names this seat, and the owner sends it through `registerAgent`. The agent id comes from the event; the console then calls `POST /agents/bind`. |
| Hosting | both | Rewards arriving at the vault show as unsettled; anyone settles, each party claims its own share. |
| Exit | owner | `withdrawNFT` returns the seat and ends the agreement; rewards already in the vault stay claimable. |

## Signing the pairing

The operator key lives with the host. Either run the host's console with `OPERATOR_KEY=0x…` in the environment (the key signs the pairing digest and nothing else; it never sends a transaction and is never printed), or connect the operator's wallet to the page and sign the typed data there (`eth_signTypedData_v4`, domain `IdentityMD Worker` v2, verifying contract = the seat collection). In both cases the console first asks the vault whether it accepts the signature before anything goes to IMD.

## Configuration

`config.json`: `chainId`, `rpcUrl` (a public RPC for reads), `imdApi`, `factory`, `collection`, `rewardToken`, `registrar`, `relayOrigin`, optional `explorer`, `rewardSymbol`, `rewardDecimals`, `pollMs`, `imdPollMs`. The example pins IMD's mainnet collection, token and registrar; the factory address is filled in once it is deployed. The console refuses a vault whose collection is not the configured one, a pairing offer for another vault, chain or relay, and a register-intent that does not name this seat.

## Tests

`npm test` runs the unit tests (pairing payloads, offer strings, the step machine) and an end-to-end test that starts a local anvil chain with the real vault and factory bytecode, a fake IMD that verifies pairings through the vault's `isValidSignature`, and the console itself, then walks one agreement from creation to exit the way the page does. The end-to-end test skips when anvil or the Foundry artifacts (`forge build` in `contracts/`) are missing.

## What it does not do

It does not hold the owner's key, does not send anything to IMD that creates state except the pairing completion and the bind, and does not run the host's worker (`imd pair` is not needed: the console does the pairing for a vault-held seat). Whether IMD's relay, bind and payout routing behave as documented for a contract holder is exactly what the first live rehearsal establishes.
