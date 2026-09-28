# SeatVault: an NFT-holding vault that enforces reward sharing (design, 2026-09-28)

Local prototype only. Nothing here has been paired, deployed or funded. `contracts/src/SeatVault.sol` and its tests are isolated from `SeatEscrow` v2, which is unchanged.

## What the developer's information enables, and what stays unverified

The IMD developer says pairing accepts a seat held by a contract that implements ERC-1271 (`isValidSignature(bytes32, bytes)` returning `0x1626ba7e`), and that rewards go to the holder, whatever it is. If both hold, an NFT held by a vault receives that seat's rewards directly, and the vault can split every reward-token transfer that reaches it by immutable terms. That is the one thing this project could not enforce before: **enforceable allocation of rewards that actually arrive**.

Still unverified, because no end-to-end contract-holder pairing has been run: that `/pair/complete` really calls `isValidSignature` with the plain EIP-712 digest (`IdentityMD Worker` v2, chain id, NFT contract) and passes the signature bytes through unchanged; the exact shape of `GET /pair/:code` (the script reads `deviceKey`, `nonce`, `relayOrigin`, `chainId`, `nftContract`, which the public docs snapshot does not list); whether the ERC-8004 registration accepts the vault as `msg.sender` and what it mints or records; that the reward distributor keeps paying the current holder when the holder is a contract; and how promptly a device goes stale after the NFT leaves the vault. The smallest test that settles most of this is one spare seat NFT in one vault on mainnet, with a throwaway operator key: pair, observe `/seats/:tokenId/standing`, register the agent through the vault, wait for one payout, settle and claim, then withdraw the NFT and watch the device go stale. Each step is a separately approved live action.

## Chosen design: a separate vault composed with the escrow

Two small contracts with one job each, rather than one vault that also does rent:

- **SeatVault** (new) holds exactly one seat NFT for one agreement, answers ERC-1271 for owner-approved pairings, splits arriving reward tokens by immutable basis points, and gives the NFT back to the owner on demand.
- **SeatEscrow** (unchanged) keeps the rent clock, the deposit and fee payments.

Why composition wins on custody and accounting: rent and rewards are usually the same token (IMD), and the only way to be certain a deposit can never be mistaken for a reward is to keep deposits out of the vault entirely. The vault accepts no deposits; the escrow receives no rewards (rewards go to the NFT holder, which is the vault). A standalone agreement vault would need a ledger that tells deposits from rewards inside one balance, which is exactly the accounting that goes wrong. The vault records the escrow agreement id for the UI only.

## Custody

The vault is the on-chain holder: the owner `deposit()`s (a real `safeTransferFrom` into the vault; an approval alone does nothing) and only the agreed seat is accepted from the seat collection, only from the owner, only once; any other collection's token is accepted and rescuable, because an identity registry may safe-mint one here. The owner keeps the withdrawal right: `withdrawNFT(to)` whenever the vault actually holds the seat, before or after the agreement ended, whether it arrived by deposit or by a plain transfer, with no provider signature and no admin. Withdrawal settles the reward token first when it can be read, ends the agreement, clears the pairing approval, then moves the NFT; a reward token that cannot be read never holds the seat hostage. The provider can `end()` (no new pairings) but can never move the NFT or any token but its own allocation. There is no admin key, no sweep, no upgrade.

## Pairing authority (ERC-1271), exactly

- The vault keeps a single active approval. `approvePairing(nonce, expiresAt, relayOrigin)` by the owner computes the WorkerAuthorization digest itself from the agreed device key, its own address as `wallet`, its token, IMD's nonce, the expiry and the agreed relay, and records it with its expiry and the chain id, replacing any earlier approval. It refuses another relay, an expiry in the past or more than one hour out, a vault that does not hold the NFT, or an ended agreement. Changing the device key, revoking, ending or withdrawing clears the approval.
- `isValidSignature(hash, signature)` returns the magic value only when: the NFT is held, the agreement is open, `hash` is the active approved digest, not expired, approved on this chain id, and the signature recovers to the operator key (the host's pairing key) or the owner. The operator key must differ from both the owner's and the provider's keys, or the vault refuses to be created. Anything else returns `0xffffffff` without reverting. Consequences: no arbitrary hash is ever valid, so the operator key cannot be used to sign a token approval or a transfer; a digest approved for one nonce cannot be replayed for another; a digest from another chain, relay, device, wallet or token is a different hash and is never approved; after exit or withdrawal nothing validates; a leaked operator key can at most complete a pairing the owner already approved.
- Revoking an approval, ending, or changing the device key only prevents new pairings. A device IMD already enrolled stays enrolled until IMD sees the holder change, which is what withdrawing the NFT does. Nothing in the vault disconnects a device.
- The operator key has no other power: the vault has no generic `execute`. The only owner-supplied call the vault makes is `registerAgent(data)` to the pinned identity registry (the ERC-8004 registration IMD asks the holder to send); the registry can be neither the seat collection nor the reward token and must have code, and the call is reentrancy-guarded. The exact registration calldata still has to be inspected against the real registry before use.

## Reward accounting

ERC-20 transfers do not call the recipient, so the vault settles by balance difference: `settle(token)` allocates `balance - accounted` between owner and provider (owner gets the floor of its share, provider the remainder, rounded once per settlement, full-precision arithmetic), then records the new accounted balance. Every positive balance change of a token is shared, whatever its source: a misdirected top-up or a donation is split like a reward, and the vault cannot tell them apart. Every `claim(token)` settles first, so nothing can be claimed past an incoming transfer, and `withdrawNFT` settles before the NFT leaves. Claims are per party; neither party, and no admin, can take the other's allocation. Any ERC-20 that lands in the vault can be settled and claimed by the same rule, so nothing gets stuck, which the developer warned about. Rent and collateral never enter the vault.

## Isolation

One NFT per vault, one vault per agreement (a factory pins the collection, reward token, identity registry and relay). IMD pays per agent to the holder; on 2026-09-23 it paid one aggregated transfer per wallet. With a single NFT in the vault every transfer into it belongs to that seat, so attribution needs no oracle. Two seats in one holder would bring the wallet-aggregation ambiguity back.

## Exit, late rewards, provider changes

Ending the agreement, taking the NFT back, and the device disconnecting are three different events. `end()` stops new pairings; `withdrawNFT()` also returns the NFT and, on IMD's side, makes the enrolled device stale (the enrolment is tied to the holder). The escrow's rent clock is stopped separately by `SeatEscrow.end`. Rewards that reached the vault before withdrawal are allocated before the NFT leaves. Rewards paid after withdrawal go to the new holder (the owner's wallet), not the vault; there is no job or period attribution and no grace rule, so the provider's enforced share ends with the withdrawal. A provider change is a new vault: withdraw, re-deposit into the new one, pair the new device. Anything that still lands in an ended vault is split by the same terms.

## Tokens

Rewards are IMD, a plain ERC-20. Claims check exact delivery on both sides, so a recipient-tax or sender-surcharge token is refused rather than short-paying. Balance-difference accounting assumes balances only change through transfers: with a rebasing, upgradeable or dishonest token the first claimant is paid in full and the last one bears the loss (`shortfall(token)` shows the gap). Pin one verified asset per factory.

## Trust limits (do not call this trustless)

Enforced: the split of rewards that reach the vault; the owner's unilateral exit with the NFT; the operator key's confinement to approved pairings. Not enforced: service quality, payout policy (IMD decides who gets paid and how much), rewards paid after withdrawal, and rent (that stays in the escrow, backed by the deposit only). The owner still needs to be online for each pairing approval within IMD's five-minute code window.
