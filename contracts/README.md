# SeatEscrow (contracts)

The on-chain piece of Seat Market: **a rental with a security deposit**, one agreement per hosted seat. This is the simplified model the project owner chose on 2026-09-28 after the floor-and-acknowledgment version was built and reviewed; that version is preserved in git history (commits `8db325b` and `41af180`).

**Status: local Foundry project with unit, fuzz, invariant and review-probe suites. Not deployed anywhere. Not audited.**

## The rule, in one sentence

You rent a host by the day, you put down a small deposit, the host can take the fee from it if you stop paying, otherwise you get it back the moment you leave, and you pass the host its share of rewards yourself.

## What the contract does

- **Terms** (immutable per agreement): owner, provider, token, `dailyFee`, `shareBps` (the reward share the owner promises; informational, not enforced), `requiredDeposit` (at least one day of fee; zero for a pure revenue-share listing), and `docHash` of the full off-chain terms. `approve` must present `termsDigest(...)`, which the contract derives from those numbers, the document hash, its own address and the chain id, so a counterparty commits to real terms rather than a label.
- **Setup**: `propose` by either party (counts as their approval), `approve` by the other, `deposit` by the owner, `activate` by the owner once the deposit is funded. Only the owner can start the clock.
- **Fee**: accrues per second at `dailyFee / 24 h` from activation until either party calls `end`. The provider may `draw` unpaid fee from the deposit at any time, capped by what the deposit holds. The owner may `payFee` with fresh funds instead, capped by what is owed, so nothing can be prepaid. Top-ups via `deposit` never pay anyone by themselves.
- **Share**: `payShare(amount, payoutRef)` by the owner, any time after activation including after exit, with the payout's transaction hash as the reference. Recorded in an event, never counted against fee, never drawn from the deposit.
- **Exit**: `end` by either party freezes the fee. `refund` by the owner is immediate and releases the deposit beyond unpaid fee; unpaid fee stays reserved for the provider to `draw`. `claim` by the provider pulls everything funded and works after exit.
- **Safety**: every amount and rate is bounded by 2^128 so nothing overflows; transfers in and out are checked for the exact amount, so fee-on-transfer, outbound-tax and similar tokens are refused and one agreement can never spend another's deposit; every money entrypoint is reentrancy-guarded; no admin, no upgrade path, no sweep.
- **Exposure**: `unsecured(id)` = unpaid fee beyond the deposit. A host's pause rule watches that number; the deposit size is the host's tolerance in days.

## What it deliberately does not do

- It cannot see rewards, which land in the owner's wallet, so the share is honour-based and public. Knowing the payer contract makes disputes mechanical, not enforceable.
- It does not observe pairing, NFT transfers or uptime, and it does not pause a worker. The public IMD standing routes are the evidence source (see `../CONTRACT-SPEC.md`).

## Layout

```text
src/SeatEscrow.sol                 the contract (Solidity 0.8.30, OpenZeppelin 5.4.0 SafeERC20 + ReentrancyGuard)
test/SeatEscrow.t.sol              unit tests (incl. the owner's scenarios) + a fuzz of the fee clock against a naive computation
test/SeatEscrowInvariants.t.sol    handler-driven invariants: cash conservation, fee never settled beyond accrual, refunds
                                   keep unpaid fee reserved, fee frozen at exit, escrow balance = reserve + claim
test/SeatEscrowReviewProbes.t.sol  probes carried over from Codex's review: token callbacks against all six money
                                   entrypoints, outbound-tax tokens, same-block sequences, late payment after refund
test/Mocks.sol                     MockERC20 (stands in for IMD on a testnet) and a fee-on-transfer token
script/Deploy.s.sol                testnet deployment of the mock token and the escrow
```

## Run

```text
forge build
forge test              # 25 unit/fuzz/probe tests + 7 invariants (64 runs x 64 calls)
forge test --gas-report
forge fmt --check src test script
```

Foundry 1.8.3 is the pinned toolchain (the same release the IMD verifier runs). Dependencies are git submodules pinned in `foundry.lock`: `lib/openzeppelin-contracts` v5.4.0, `lib/forge-std` v1.16.2.

## Gas (unit suite, `forge test --gas-report`)

| Function | Typical | Max |
| --- | ---: | ---: |
| deposit | 95k | 95k |
| payFee | 69k | 103k |
| payShare | 70k | 96k |
| draw | 52k | 86k |
| claim | 73k | 73k |
| refund | 61k | 64k |
| propose | 230k | 230k |

Constant per call; nothing grows with the agreement's history.

## Review history

- 2026-09-28, Codex, floor model at `8db325b`: two medium findings (oversized-acknowledgment overflow; outgoing transfers not checked for the exact amount), both fixed in `41af180`; its tests are carried over here where they still apply. Report and original tests are kept locally under `review/`.
- 2026-09-28, rental model (this version): built on the project owner's decision; awaiting a second Codex pass.

## Next steps

1. Second review of this version (`../docs/SWARM-REVIEW-BRIEF.md` for the swarm, once a public mirror or archive exists; Codex meanwhile).
2. Sepolia deployment with a throwaway key and testnet ETH (`script/Deploy.s.sol`); record the addresses here.
3. Wire the site to the contract: wallet connector, the six money actions, the `unsecured` warning, and a payout observer that pre-fills `payShare` from the Disperse contract's transfers.
4. Chain and deposit asset are still open questions (mainnet where rewards land versus Base for cheap daily transactions; IMD versus a stablecoin).
