#!/usr/bin/env bash
# Testnet walkthrough of the SeatVault lifecycle with cast (Base Sepolia by default). Reads throwaway keys from
# the JSON files `cast wallet new --json` wrote and hands them to cast as arguments; it never prints them, and shell
# tracing is switched off below (do not run it with `bash -x`). Every step asserts the state it expects and the
# script stops at the first mismatch. Nothing here touches IMD.
#   bash script/testnet-walkthrough.sh <vault> <seats> <imd> [rpc]
set -euo pipefail
set +x
VAULT="${1:?vault address}"; SEATS="${2:?mock seats address}"; IMD="${3:?mock imd address}"
RPC="${4:-https://sepolia.base.org}"
# Testnet guard first: no key is read and nothing is signed unless the RPC is Sepolia or Base Sepolia.
CHAIN=$(cast chain-id --rpc-url "$RPC" 2>/dev/null || echo unknown)
case "$CHAIN" in
  11155111|84532) echo "chain $CHAIN ok" ;;
  *) echo "refusing: chain $CHAIN is not Sepolia (11155111) or Base Sepolia (84532)"; exit 3 ;;
esac
KEYS="${KEYS:-$HOME/.ssh}"
key() { python -c "import json,sys; d=json.load(open(sys.argv[1]))['data']; w=d[0] if isinstance(d,list) else d; print(w['private_key'])" "$KEYS/$1.json"; }
addr() { python -c "import json,sys; d=json.load(open(sys.argv[1]))['data']; w=d[0] if isinstance(d,list) else d; print(w['address'])" "$KEYS/$1.json"; }
OWNER_KEY=$(key imd_sepolia_deployer); OWNER=$(addr imd_sepolia_deployer)
PROVIDER_KEY=$(key imd_sepolia_provider); PROVIDER=$(addr imd_sepolia_provider)
OPERATOR_KEY=$(key imd_sepolia_operator); OPERATOR=$(addr imd_sepolia_operator)
TOKEN="${TOKEN:-2048}"
SETTLE="${SETTLE:-6}"   # seconds to let a load-balanced public RPC catch up before reading state

# Polls for one hash's receipt. A receipt counts only if it is for THIS hash, is mined (has a block number) and
# has status 1: a success receipt for some other transaction is a mismatch, not a confirmation. Returns
# 0 = mined with status 1, 2 = reverted, 3 = the node answered with another transaction's receipt, 1 = no receipt yet.
receipt() {
  local hash="$1" tries="$2" out verdict i
  for i in $(seq 1 "$tries"); do
    if out=$(cast receipt --rpc-url "$RPC" --json "$hash" 2>/dev/null) && [ -n "$out" ] && [ "$out" != "null" ]; then
      verdict=$(echo "$out" | python -c '
import json, sys
want = sys.argv[1].lower()
r = json.load(sys.stdin)
got = str(r.get("transactionHash") or "").lower()
status = str(r.get("status"))
# a receipt must carry its block: a missing or null blockNumber is a stub or a pending answer, never a confirmation
# (no apostrophes in this block: it sits inside bash single quotes)
mined = r.get("blockNumber") not in (None, "", "null")
if got != want: print("mismatch " + (got or "<no transactionHash>"))
elif not mined: print("pending")
elif status in ("0x1", "1", "True"): print("ok")
else: print("reverted status " + status)' "$hash")
      echo "  tx $hash receipt: $verdict"
      case "$verdict" in
        ok|0x1|1|True) return 0 ;;                     # bare statuses: a parser stub that prints only the status field
        reverted*|0x0|0|False) echo "  transaction reverted"; return 2 ;;
        mismatch*) echo "  the receipt returned for $hash belongs to another transaction: not a confirmation"; return 3 ;;
      esac
    fi
    sleep 3
  done
  return 1
}
# Nonces are read once per key and then counted locally, so a lagging node cannot hand out a stale one mid-run.
# A failed or malformed read stops the caller: an empty --nonce would sign as nonce zero (Foundry 1.8.3), which is
# a real transaction for a fresh key. Each rehearsal key must be used by this script alone while it runs.
declare -A NONCE
next_nonce() {
  local from="$1" n
  if [ -z "${NONCE[$from]:-}" ]; then
    if ! n=$(cast nonce --rpc-url "$RPC" "$from") || ! [[ "$n" =~ ^[0-9]+$ ]]; then
      echo "  nonce read for $from failed (got '${n:-}'): nothing signed" >&2
      return 1
    fi
    NONCE[$from]=$n
  fi
  echo "${NONCE[$from]}"
}
# Sends one call at most once WITHIN ONE INVOCATION of send. The transaction is signed once with one nonce
# (cast mktx); every retry re-broadcasts those same bytes, so the call can never run twice here, and success means
# a receipt for their hash with status 1. When no receipt appears, or the node returns another transaction's
# receipt, the script stops and says so: that is not proof that nothing executed, so nothing is ever rebuilt with
# another nonce. Across a restart the operator must reconcile the printed hash by hand before re-running.
send() {
  local who="$1"; shift
  local from nonce raw hash out i rc
  from=$(cast wallet address --private-key "$who")
  nonce=$(next_nonce "$from") || { echo "  stopping: no nonce for $from"; return 1; }
  [[ "$nonce" =~ ^[0-9]+$ ]] || { echo "  stopping: nonce '$nonce' is not a number"; return 1; }
  raw=$(cast mktx --rpc-url "$RPC" --private-key "$who" --nonce "$nonce" "$@")
  hash=$(cast keccak "$raw")
  for i in 1 2 3 4; do
    if out=$(cast publish --rpc-url "$RPC" --async "$raw" 2>&1) || echo "$out" | grep -qiE "already known|nonce too low|underpriced"; then
      # a node has these bytes, or reports the nonce used: only the receipt can say what happened. The local hash
      # stays the transaction's identity even if the node echoes a different one.
      if [[ "$out" =~ ^0x[0-9a-fA-F]{64}$ ]] && [ "$(echo "$out" | tr 'A-F' 'a-f')" != "$(echo "$hash" | tr 'A-F' 'a-f')" ]; then
        echo "  publish answered with a different hash ($out) than the locally computed $hash: polling the local hash only"
      fi
      break
    fi
    echo "  broadcast attempt $i failed: $(echo "$out" | head -c 200)"; sleep 4
  done
  rc=0; receipt "$hash" 15 || rc=$?
  if [ "$rc" = 0 ]; then NONCE[$from]=$((nonce + 1)); sleep "$SETTLE"; return 0; fi
  if [ "$rc" = 2 ]; then return 1; fi
  if [ "$rc" = 3 ]; then echo "  ambiguous: another transaction's receipt came back for $hash (nonce $nonce); not retried; check that hash by hand"; return 1; fi
  echo "  no receipt for $hash (nonce $nonce) after 45 s: not retried with another nonce; check that hash by hand, then re-run"
  return 1
}
call() { cast call --rpc-url "$RPC" "$@" | awk 'NR==1{print $1}'; }
say() { echo; echo "== $*"; }
# Asserts one observed value (case-insensitive) and stops the script otherwise.
expect() {
  local label="$1" got="$2" want="$3"
  if [ "$(echo "$got" | tr 'A-Z' 'a-z')" != "$(echo "$want" | tr 'A-Z' 'a-z')" ]; then
    echo "  FAIL $label: got $got, expected $want"; exit 4
  fi
  echo "  ok $label = $got"
}
minus() { python -c "import sys; print(int(sys.argv[1]) - int(sys.argv[2]))" "$1" "$2"; }

say "roles: owner $OWNER · provider $PROVIDER · operator $OPERATOR"
say "0. the owner must hold mock seat $TOKEN (minted here if the mock collection has none)"
if ! call "$SEATS" "ownerOf(uint256)(address)" "$TOKEN" >/dev/null 2>&1; then send "$OWNER_KEY" "$SEATS" "mint(address,uint256)" "$OWNER" "$TOKEN"; fi
expect "ownerOf($TOKEN)" "$(call "$SEATS" "ownerOf(uint256)(address)" "$TOKEN")" "$OWNER"
PROVIDER_BEFORE=$(call "$IMD" "balanceOf(address)(uint256)" "$PROVIDER")

say "1. owner approves the vault for the seat NFT, then deposits it"
send "$OWNER_KEY" "$SEATS" "approve(address,uint256)" "$VAULT" "$TOKEN"
send "$OWNER_KEY" "$VAULT" "deposit()"
expect "ownerOf($TOKEN)" "$(call "$SEATS" "ownerOf(uint256)(address)" "$TOKEN")" "$VAULT"
expect "held" "$(call "$VAULT" "held()(bool)")" "true"

say "2. owner approves one pairing (nonce from IMD; here a rehearsal nonce), signature expiry 10 min"
PAIR_NONCE=$(cast keccak "rehearsal nonce $(date +%s)")
NOW=$(cast block --rpc-url "$RPC" latest --field timestamp); EXP=$((NOW + 600))
send "$OWNER_KEY" "$VAULT" "approvePairing(bytes32,uint64,string)" "$PAIR_NONCE" "$EXP" "https://api.imd.fun"
DEVICE=$(call "$VAULT" "deviceKey()(bytes32)")
DIGEST=$(call "$VAULT" "workerAuthorizationDigest(bytes32,bytes32,uint64)(bytes32)" "$DEVICE" "$PAIR_NONCE" "$EXP")
echo "  digest $DIGEST"
expect "approvedDigest" "$(call "$VAULT" "approvedDigest()(bytes32)")" "$DIGEST"
expect "approvedUntil" "$(call "$VAULT" "approvedUntil()(uint64)")" "$EXP"

say "3. operator signs the digest (what the pairing script would send to IMD); the vault answers as a relay would"
SIG=$(cast wallet sign --no-hash --private-key "$OPERATOR_KEY" "$DIGEST")
expect "isValidSignature(operator)" "$(call "$VAULT" "isValidSignature(bytes32,bytes)(bytes4)" "$DIGEST" "$SIG")" "0x1626ba7e"
BAD=$(cast wallet sign --no-hash --private-key "$PROVIDER_KEY" "$DIGEST")
expect "isValidSignature(wrong key)" "$(call "$VAULT" "isValidSignature(bytes32,bytes)(bytes4)" "$DIGEST" "$BAD")" "0xffffffff"

say "4. a payout arrives: the owner key plays the Disperse contract and sends 100 mock IMD to the vault"
send "$OWNER_KEY" "$IMD" "transfer(address,uint256)" "$VAULT" 100000000000000000000
expect "pending" "$(call "$VAULT" "pending(address)(uint256)" "$IMD")" "100000000000000000000"

say "5. provider claims (settles first), then owner claims"
send "$PROVIDER_KEY" "$VAULT" "claim(address)" "$IMD"
expect "provider received" "$(minus "$(call "$IMD" "balanceOf(address)(uint256)" "$PROVIDER")" "$PROVIDER_BEFORE")" "30000000000000000000"
expect "owner claimable" "$(call "$VAULT" "claimable(address,address)(uint256)" "$IMD" "$OWNER")" "70000000000000000000"
send "$OWNER_KEY" "$VAULT" "claim(address)" "$IMD"
expect "vault balance" "$(call "$IMD" "balanceOf(address)(uint256)" "$VAULT")" "0"

say "6. owner takes the NFT back without the provider; pairing approval dies with it"
send "$OWNER_KEY" "$VAULT" "withdrawNFT(address)" "$OWNER"
expect "ownerOf($TOKEN)" "$(call "$SEATS" "ownerOf(uint256)(address)" "$TOKEN")" "$OWNER"
expect "ended" "$(call "$VAULT" "ended()(bool)")" "true"
expect "isValidSignature(after withdrawal)" "$(call "$VAULT" "isValidSignature(bytes32,bytes)(bytes4)" "$DIGEST" "$SIG")" "0xffffffff"
say "done: every assertion held"
