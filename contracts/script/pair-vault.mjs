#!/usr/bin/env node
// pair-vault.mjs: complete an IMD pairing for a seat NFT held by a SeatVault (an ERC-1271 holder).
//
// Adapted from the IMD developer's reference script, with validation and a dry run by default.
//   node pair-vault.mjs <CODE | fixture.json> --vault 0x... --token 2048
//        [--chain 1] [--collection 0x0000ec93127baa929e58e97dd0095a2bfb38ec1d] [--relay https://api.imd.fun]
//        [--expires 600] [--sign] [--live] [--selftest]
//
// What it does:
//   1. Loads the pairing response (a JSON fixture, or GET /pair/<code> only with --live).
//   2. Validates shape, hex prefixes, chain id, NFT contract, relay origin and pairing state.
//   3. Prints the exact approvePairing(nonce, expiresAt, relayOrigin) call the OWNER must send from the vault,
//      and the EIP-712 digest (needs viem), so the on-chain approval can be checked before anything is signed.
//   4. With --sign and OPERATOR_KEY in the environment: signs the typed data with the operator key (never printed).
//   5. With --live and --sign: POSTs /pair/complete. Never without both flags.
//
// Two clocks: IMD's pairing code lives about five minutes after `imd pair` printed it; the signature's own
// expiresAt (--expires, default 600 s, at most the vault's one-hour window) is separate. The owner's approval
// transaction must be mined before /pair/complete is called, so run this early in the five minutes.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const has = (name) => args.includes(name);

const API = "https://api.imd.fun";
const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function validatePairing(p, expect) {
  const problems = [];
  if (!p || typeof p !== "object") return ["pairing response is not an object"];
  if (!HEX32.test(String(p.deviceKey ?? ""))) problems.push("deviceKey is not 32 bytes of hex");
  if (!HEX32.test(String(p.nonce ?? ""))) problems.push("nonce is not 32 bytes of hex");
  if (typeof p.relayOrigin !== "string" || p.relayOrigin !== expect.relay) {
    problems.push(`relayOrigin ${JSON.stringify(p.relayOrigin)} is not the agreed ${expect.relay}`);
  }
  if (Number(p.chainId) !== expect.chain) problems.push(`chainId ${p.chainId} is not ${expect.chain}`);
  if (String(p.nftContract ?? "").toLowerCase() !== expect.collection.toLowerCase()) {
    problems.push(`nftContract ${p.nftContract} is not the agreed collection ${expect.collection}`);
  }
  if (p.consumed) problems.push("pairing code already consumed");
  if (p.enrolled) problems.push("token already enrolled; unlink or withdraw first");
  if (p.expiresAt) {
    const t = typeof p.expiresAt === "number" ? p.expiresAt * 1000 : Date.parse(p.expiresAt);
    if (Number.isFinite(t) && t < Date.now()) problems.push("pairing code has expired");
  }
  if (p.tokenId !== undefined && String(p.tokenId) !== String(expect.token)) {
    problems.push(`response tokenId ${p.tokenId} is not the vault's token ${expect.token}`);
  }
  return problems;
}

export function buildMessage(p, expect, nowSeconds) {
  const strip = (h) => String(h).replace(/^0x/, "").toLowerCase();
  return {
    deviceKey: "0x" + strip(p.deviceKey),
    wallet: expect.vault.toLowerCase(),
    tokenId: BigInt(expect.token),
    nonce: "0x" + strip(p.nonce),
    expiresAt: BigInt(nowSeconds + expect.expires),
    relayOrigin: p.relayOrigin,
  };
}

export const typedData = (p, expect, message) => ({
  domain: { name: "IdentityMD Worker", version: "2", chainId: expect.chain, verifyingContract: expect.collection },
  types: {
    WorkerAuthorization: [
      { name: "deviceKey", type: "bytes32" },
      { name: "wallet", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "relayOrigin", type: "string" },
    ],
  },
  primaryType: "WorkerAuthorization",
  message,
});

function selftest() {
  const expect = { relay: API, chain: 1, collection: "0x0000ec93127baa929e58e97dd0095a2bfb38ec1d", token: "2048", vault: "0x" + "ab".repeat(20), expires: 600 };
  const good = { deviceKey: "aa".repeat(32), nonce: "bb".repeat(32), relayOrigin: API, chainId: 1, nftContract: expect.collection };
  const ok = validatePairing(good, expect);
  const bad = validatePairing({ ...good, relayOrigin: "https://evil.example", chainId: 8453, nonce: "zz", consumed: true }, expect);
  const shape = validatePairing("nope", expect);
  const m = buildMessage(good, expect, 1_800_000_000);
  const pass = ok.length === 0 && bad.length === 4 && shape.length === 1 && m.deviceKey === "0x" + "aa".repeat(32) && m.expiresAt === 1_800_000_600n;
  console.log(pass ? "selftest ok" : `selftest FAILED: ${JSON.stringify({ ok, bad, shape, m: String(m.expiresAt) })}`);
  process.exit(pass ? 0 : 1);
}

if (has("--selftest")) selftest();

const src = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true) ?? args[0];
const expect = {
  relay: flag("--relay", API),
  chain: Number(flag("--chain", "1")),
  collection: flag("--collection", "0x0000ec93127baa929e58e97dd0095a2bfb38ec1d"),
  token: flag("--token"),
  vault: flag("--vault"),
  expires: Number(flag("--expires", "600")),
};
if (!src || !expect.token || !ADDR.test(expect.vault ?? "") || !/^\d+$/.test(expect.token)) {
  console.error("usage: node pair-vault.mjs <CODE|fixture.json> --vault 0x... --token <id> [--sign] [--live]");
  process.exit(2);
}
if (!(expect.expires > 0 && expect.expires <= 3600)) {
  console.error("--expires must be 1..3600 seconds (the vault's MAX_PAIRING_WINDOW is one hour)");
  process.exit(2);
}

let pairing;
if (src.endsWith(".json")) {
  pairing = JSON.parse(readFileSync(src, "utf8"));
} else if (has("--live")) {
  if (!/^[A-Za-z0-9]{4,16}$/.test(src)) { console.error("pairing code must be 4-16 alphanumerics"); process.exit(2); }
  pairing = await (await fetch(`${API}/pair/${src}`, { headers: { accept: "application/json" } })).json();
} else {
  console.error("refusing to contact the live API without --live; pass a fixture .json for a dry run");
  process.exit(2);
}

const problems = validatePairing(pairing, expect);
if (problems.length) {
  console.error("pairing response rejected:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
const now = Math.floor(Date.now() / 1000);
const message = buildMessage(pairing, expect, now);
console.log("owner approval to send from the vault (must be mined before /pair/complete):");
console.log(`  approvePairing(${message.nonce}, ${message.expiresAt}, ${JSON.stringify(message.relayOrigin)})`);
console.log(`  device ${message.deviceKey} · wallet ${message.wallet} · token ${message.tokenId} · chain ${expect.chain}`);
console.log(`  signature expiresAt ${message.expiresAt} (${expect.expires}s from now); IMD's code expires about 5 minutes after it was printed`);

let viem;
try { viem = await import("viem"); } catch { viem = null; }
if (!viem) {
  console.log("viem is not installed: digest and signing skipped (npm i viem to enable). Validation passed.");
  process.exit(0);
}
const digest = viem.hashTypedData(typedData(pairing, expect, message));
console.log(`  digest ${digest} (compare with vault.workerAuthorizationDigest(deviceKey, nonce, expiresAt))`);

if (!has("--sign")) { console.log("dry run: nothing signed, nothing sent"); process.exit(0); }
if (!process.env.OPERATOR_KEY) { console.error("--sign needs OPERATOR_KEY in the environment"); process.exit(2); }
const { privateKeyToAccount } = await import("viem/accounts");
const signature = await privateKeyToAccount(process.env.OPERATOR_KEY).signTypedData(typedData(pairing, expect, message));
console.log(`  signature ${signature}`);
if (!has("--live")) { console.log("signed, not sent (add --live to POST /pair/complete)"); process.exit(0); }

const body = {
  code: src,
  signature,
  message: {
    ...message,
    tokenId: String(message.tokenId),
    expiresAt: Number(message.expiresAt),
    deviceKey: message.deviceKey.slice(2),
    nonce: message.nonce.slice(2),
  },
};
const r = await fetch(`${API}/pair/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
console.log(r.status, await r.text());
