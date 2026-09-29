# Host helper

A small program the host runs beside the worker. It talks to IMD, signs one pairing with the operator key, and hands the owner two strings to paste into the agreement page. It never sends a transaction and never holds the owner's key.

```
cd host
npm install
copy config.example.json config.json     # fill in the factory address for your chain
```

`config.json`: `chainId`, `rpcUrl` (a public RPC), `imdApi`, `factory`, `collection`, `rewardToken`, `registrar`, `relayOrigin`. The example pins IMD's mainnet collection, token and registrar.

## The host's three commands

```
node helper.mjs offer --provider 0x… --operator 0x… --device-key <64 hex> --bps 3000
```
Prints the **hosting offer** (`seathost1:…`): your payout address, the operator address whose key this machine holds, your worker's device key (`imd status` prints it), and your share in basis points. Send it to the owner once. The owner creates the vault from it and sends you the vault address back.

```
OPERATOR_KEY=0x… node helper.mjs pair <vault>
```
One attempt, run to the end: checks the vault is one of the factory's with your operator, finds whether an agent already exists for the seat (reused when the registrar says the vault controls it), otherwise fetches IMD's registration intent and checks it names this seat, asks IMD for a pairing code, prints the **pairing string** (`seatpair1:…`) for the owner, waits for the owner's exact approval on chain, signs with the operator key, checks the vault accepts the signature, completes the pairing with IMD, then binds the agent (the reused one, or the one the owner registers, watched from the block the attempt started) and waits until IMD's standing shows your device. The owner has about five minutes from the print to approve.

```
OPERATOR_KEY=0x… node helper.mjs resume <vault>
node helper.mjs status <vault>
```
`resume` continues the recorded attempt after a restart or a pending bind; it never asks for a second code while one is live. `status` prints the vault and IMD's view.

The record of the current attempt lives in `data/<vault>.json` (ignored by git): phase, the pairing string, the block the attempt started at. No key is ever written there.

## Safety

Everything the helper accepts is checked: the vault against the factory, collection, registrar, reward token, relay and operator; IMD's pairing response against the agreed relay, chain and collection; the registration intent against the pinned registrar and this seat. The operator key signs exactly one thing, the WorkerAuthorization digest the owner approved on the vault, and only after the vault has answered that it accepts the signature. Stopping the helper stops future steps; it cannot recall a completion already posted or an approval already sent.

## Tests

`npm test` runs the unit tests (pairing payloads, offer strings, the step machine) and an offline end-to-end run: a local anvil chain with the real vault and factory bytecode, a fake IMD that verifies pairings through the vault's `isValidSignature`, the owner's transactions built exactly as the page builds them, the helper restarted in the middle of an attempt, rewards claimed by both parties, exit, a claim after exit, and a second agreement that reuses an existing agent. It skips when anvil or the Foundry artifacts (`forge build` in `contracts/`) are missing.

## What it does not prove

Whether IMD's relay, bind and payout routing behave as documented for a contract holder. That is what the first live rehearsal establishes.
