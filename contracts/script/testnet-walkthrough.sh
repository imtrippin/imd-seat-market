#!/usr/bin/env bash
# Testnet walkthrough of the SeatVault lifecycle with cast (Base Sepolia by default). Reads throwaway keys from
# the JSON files `cast wallet new --json` wrote; never prints them. Every step prints what it did and the state
# it produced. Nothing here touches IMD.
#   bash script/testnet-walkthrough.sh <vault> <seats> <imd> [rpc]
set -euo pipefail
VAULT="${1:?vault address}"; SEATS="${2:?mock seats address}"; IMD="${3:?mock imd address}"
RPC="${4:-https://sepolia.base.org}"
KEYS="${KEYS:-$HOME/.ssh}"
key() { python -c "import json,sys; d=json.load(open(sys.argv[1]))['data']; w=d[0] if isinstance(d,list) else d; print(w['private_key'])" "$KEYS/$1.json"; }
addr() { python -c "import json,sys; d=json.load(open(sys.argv[1]))['data']; w=d[0] if isinstance(d,list) else d; print(w['address'])" "$KEYS/$1.json"; }
OWNER_KEY=$(key imd_sepolia_deployer); OWNER=$(addr imd_sepolia_deployer)
PROVIDER_KEY=$(key imd_sepolia_provider); PROVIDER=$(addr imd_sepolia_provider)
OPERATOR_KEY=$(key imd_sepolia_operator); OPERATOR=$(addr imd_sepolia_operator)
TOKEN="${TOKEN:-2048}"
SETTLE="${SETTLE:-6}"   # seconds to let a load-balanced public RPC catch up before reading state
send() {
  local who="$1"; shift
  local out i
  for i in 1 2 3 4; do
    out=$(cast send --rpc-url "$RPC" --private-key "$who" "$@" --json 2>&1) || true
    if echo "$out" | grep -q '"transactionHash"'; then
      echo "$out" | python -c "import json,sys; r=json.load(sys.stdin); print('  tx', r['transactionHash'], 'status', r['status'])"; sleep "$SETTLE"; return 0
    fi
    echo "  attempt $i: $(echo "$out" | head -c 200)"; sleep 4
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
echo "  digest $DIGEST   approved until $(call "$VAULT" "pairingApprovedUntil(bytes32)(uint64)" "$DIGEST")"

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
