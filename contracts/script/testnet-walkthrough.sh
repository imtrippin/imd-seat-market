#!/usr/bin/env bash
# Testnet walkthrough of the SeatVault lifecycle with cast (Base Sepolia by default). Reads throwaway keys from
# the JSON files `cast wallet new --json` wrote; never prints them. Every step prints what it did and the state
# it produced. Nothing here touches IMD.
#   bash script/testnet-walkthrough.sh <vault> <seats> <imd> [rpc]
set -euo pipefail
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

# Polls for one hash's receipt and prints its status. 0 = mined with status 1, 2 = reverted, 1 = no receipt yet.
receipt() {
  local hash="$1" tries="$2" out status i
  for i in $(seq 1 "$tries"); do
    if out=$(cast receipt --rpc-url "$RPC" --json "$hash" 2>/dev/null) && [ -n "$out" ] && [ "$out" != "null" ]; then
      status=$(echo "$out" | python -c "import json,sys; print(json.load(sys.stdin).get('status'))")
      echo "  tx $hash status $status"
      case "$status" in 0x1|1|True) return 0 ;; *) echo "  transaction reverted"; return 2 ;; esac
    fi
    sleep 3
  done
  return 1
}
# Sends one call exactly once. The transaction is signed locally with an explicit nonce (cast mktx), so a retry can
# only re-broadcast the same bytes with the same hash, never the call twice; success means a receipt for that hash
# with status 1. When a node calls the nonce taken (the previous step still settling on a lagging node), our hash
# is checked for a receipt first and only then is the transaction rebuilt with a fresh nonce.
send() {
  local who="$1"; shift
  local from nonce raw hash out i build rc
  from=$(cast wallet address --private-key "$who")
  for build in 1 2 3; do
    nonce=$(cast nonce --rpc-url "$RPC" "$from")
    raw=$(cast mktx --rpc-url "$RPC" --private-key "$who" --nonce "$nonce" "$@")
    hash=$(cast keccak "$raw")
    for i in 1 2 3 4; do
      if out=$(cast publish --rpc-url "$RPC" --async "$raw" 2>&1) || echo "$out" | grep -qi "already known"; then
        rc=0; receipt "$hash" 15 || rc=$?
        [ "$rc" = 0 ] && { sleep "$SETTLE"; return 0; }
        [ "$rc" = 2 ] && return 1
        echo "  no receipt for $hash after 45 s: check it by hand before continuing"; return 1
      fi
      if echo "$out" | grep -qiE "nonce too low|underpriced"; then
        rc=0; receipt "$hash" 4 || rc=$?
        [ "$rc" = 0 ] && { sleep "$SETTLE"; return 0; }
        [ "$rc" = 2 ] && return 1
        echo "  nonce $nonce is taken on this node (previous step still settling): rebuilding"; sleep 4; break
      fi
      echo "  broadcast attempt $i failed: $(echo "$out" | head -c 200)"; sleep 4
    done
  done
  echo "  giving up"; return 1
}
call() { cast call --rpc-url "$RPC" "$@"; }
say() { echo; echo "== $*"; }

say "roles: owner $OWNER · provider $PROVIDER · operator $OPERATOR"
say "0. make sure the owner holds mock seat $TOKEN (mint it if the mock collection has none)"
if ! call "$SEATS" "ownerOf(uint256)(address)" "$TOKEN" >/dev/null 2>&1; then send "$OWNER_KEY" "$SEATS" "mint(address,uint256)" "$OWNER" "$TOKEN"; fi
echo "  ownerOf($TOKEN) = $(call "$SEATS" "ownerOf(uint256)(address)" "$TOKEN")"

say "1. owner approves the vault for the seat NFT, then deposits it"
send "$OWNER_KEY" "$SEATS" "approve(address,uint256)" "$VAULT" "$TOKEN"
send "$OWNER_KEY" "$VAULT" "deposit()"
echo "  ownerOf($TOKEN) = $(call "$SEATS" "ownerOf(uint256)(address)" "$TOKEN")   held = $(call "$VAULT" "held()(bool)")"

say "2. owner approves one pairing (nonce from IMD; here a rehearsal nonce), signature expiry 10 min"
NONCE=$(cast keccak "rehearsal nonce $(date +%s)")
NOW=$(cast block --rpc-url "$RPC" latest --field timestamp); EXP=$((NOW + 600))
send "$OWNER_KEY" "$VAULT" "approvePairing(bytes32,uint64,string)" "$NONCE" "$EXP" "https://api.imd.fun"
DEVICE=$(call "$VAULT" "deviceKey()(bytes32)")
DIGEST=$(call "$VAULT" "workerAuthorizationDigest(bytes32,bytes32,uint64)(bytes32)" "$DEVICE" "$NONCE" "$EXP")
echo "  digest $DIGEST"
echo "  vault.approvedDigest = $(call "$VAULT" "approvedDigest()(bytes32)")   approved until $(call "$VAULT" "approvedUntil()(uint64)")"

say "3. operator signs the digest (what the pairing script would send to IMD); the vault answers as a relay would"
SIG=$(cast wallet sign --no-hash --private-key "$OPERATOR_KEY" "$DIGEST")
echo "  isValidSignature(operator) = $(call "$VAULT" "isValidSignature(bytes32,bytes)(bytes4)" "$DIGEST" "$SIG")   (0x1626ba7e = valid)"
BAD=$(cast wallet sign --no-hash --private-key "$PROVIDER_KEY" "$DIGEST")
echo "  isValidSignature(wrong key) = $(call "$VAULT" "isValidSignature(bytes32,bytes)(bytes4)" "$DIGEST" "$BAD")   (0xffffffff = invalid)"

say "4. a payout arrives: the owner key plays the Disperse contract and sends 100 mock IMD to the vault"
send "$OWNER_KEY" "$IMD" "transfer(address,uint256)" "$VAULT" 100000000000000000000
echo "  pending = $(call "$VAULT" "pending(address)(uint256)" "$IMD")"

say "5. provider claims (settles first), then owner claims"
send "$PROVIDER_KEY" "$VAULT" "claim(address)" "$IMD"
echo "  provider balance = $(call "$IMD" "balanceOf(address)(uint256)" "$PROVIDER")   owner claimable = $(call "$VAULT" "claimable(address,address)(uint256)" "$IMD" "$OWNER")"
send "$OWNER_KEY" "$VAULT" "claim(address)" "$IMD"
echo "  vault balance = $(call "$IMD" "balanceOf(address)(uint256)" "$VAULT")"

say "6. owner takes the NFT back without the provider; pairing approval dies with it"
send "$OWNER_KEY" "$VAULT" "withdrawNFT(address)" "$OWNER"
echo "  ownerOf($TOKEN) = $(call "$SEATS" "ownerOf(uint256)(address)" "$TOKEN")   ended = $(call "$VAULT" "ended()(bool)")"
echo "  isValidSignature(after withdrawal) = $(call "$VAULT" "isValidSignature(bytes32,bytes)(bytes4)" "$DIGEST" "$SIG")"
say "done"
