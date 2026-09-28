#!/usr/bin/env node
// pair-vault.mjs: complete an IMD pairing for a seat NFT held by a SeatVault (an ERC-1271 holder), in two phases.
//
// Adapted from the IMD developer's reference script, with validation, a persisted artifact and a dry run by default.
//
//   prepare:  node pair-vault.mjs prepare <CODE | fixture.json> --vault 0x... --token 2048 --out pairing.json
//             [--chain 1] [--collection 0x...] [--relay https://api.imd.fun] [--expires 600 | --expires-at <unix>]
//             [--live]   (a real pairing code is fetched only with --live; a fixture never needs it)
//   complete: node pair-vault.mjs complete pairing.json [--sign] [--live]
//   selftest: node pair-vault.mjs --selftest
//
// prepare validates the pairing response, fixes the ABSOLUTE signature expiry, computes the message the owner must
// approve, and writes everything to the artifact. The owner then sends `approvePairing(nonce, expiresAt,
// relayOrigin)` to the vault and waits for it to be mined. complete re-reads the artifact (never recomputing the
// time), validates every field, signs it with OPERATOR_KEY when --sign is given, and POSTs /pair/complete only when
// --live is also given. It refuses to sign or post once either clock has passed: the signature expiry, or IMD's
// pairing-code expiry when the pairing response stated one.
//
// Two clocks: IMD's pairing code lives about five minutes after `imd pair` printed it; the signature's own expiry
// (--expires, default 600 s, at most the vault's one-hour window) is separate. Both must still be valid when the
// owner's approval has been mined and the completion is posted.

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const has = (name) => args.includes(name);
const die = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};

const API = "https://api.imd.fun";
const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const CODE = /^[A-Za-z0-9]{4,16}$/;

/// Strict parse of a pairing-code expiry: Unix seconds (number or numeric string) or an ISO date. Returns ms.
export function parseExpiry(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value * 1000;
  if (typeof value === "string") {
    if (/^\d{9,11}$/.test(value)) return Number(value) * 1000;
    const t = Date.parse(value);
    if (Number.isFinite(t) && /\d{4}-\d{2}-\d{2}/.test(value)) return t;
  }
  return NaN;
}

export function validatePairing(p, expect, nowMs = Date.now()) {
  const problems = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["pairing response is not an object"];
  if (!HEX32.test(String(p.deviceKey ?? ""))) problems.push("deviceKey is not 32 bytes of hex");
  if (!HEX32.test(String(p.nonce ?? ""))) problems.push("nonce is not 32 bytes of hex");
  if (typeof p.relayOrigin !== "string" || p.relayOrigin !== expect.relay) {
    problems.push(`relayOrigin ${JSON.stringify(p.relayOrigin)} is not the agreed ${expect.relay}`);
  }
  if (!Number.isSafeInteger(Number(p.chainId)) || Number(p.chainId) !== expect.chain) {
    problems.push(`chainId ${p.chainId} is not ${expect.chain}`);
  }
  if (String(p.nftContract ?? "").toLowerCase() !== expect.collection.toLowerCase()) {
    problems.push(`nftContract ${p.nftContract} is not the agreed collection ${expect.collection}`);
  }
  if (p.consumed) problems.push("pairing code already consumed");
  if (p.enrolled) problems.push("token already enrolled; unlink or withdraw first");
  if (p.expiresAt !== undefined) {
    const t = parseExpiry(p.expiresAt);
    if (!Number.isFinite(t)) problems.push(`expiresAt ${JSON.stringify(p.expiresAt)} is not a timestamp`);
    else if (t <= nowMs) problems.push("pairing code has expired");
  }
  if (p.tokenId !== undefined && String(p.tokenId) !== String(expect.token)) {
    problems.push(`response tokenId ${p.tokenId} is not the vault's token ${expect.token}`);
  }
  return problems;
}

export function buildMessage(p, expect, expiresAtSeconds) {
  const strip = (h) => String(h).replace(/^0x/, "").toLowerCase();
  return {
    deviceKey: "0x" + strip(p.deviceKey),
    wallet: expect.vault.toLowerCase(),
    tokenId: String(expect.token),
    nonce: "0x" + strip(p.nonce),
    expiresAt: Number(expiresAtSeconds),
    relayOrigin: p.relayOrigin,
  };
}

export const typedData = (artifact) => ({
  domain: {
    name: "IdentityMD Worker",
    version: "2",
    chainId: artifact.chain,
    verifyingContract: artifact.collection,
  },
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
  message: {
    ...artifact.message,
    tokenId: BigInt(artifact.message.tokenId),
    expiresAt: BigInt(artifact.message.expiresAt),
  },
});

/// The body /pair/complete expects, mirroring the developer's reference: decimal token id, numeric expiry,
/// unprefixed device key and nonce, lowercase wallet.
export const completionBody = (artifact, signature) => ({
  code: artifact.code,
  signature,
  message: {
    ...artifact.message,
    deviceKey: artifact.message.deviceKey.slice(2),
    nonce: artifact.message.nonce.slice(2),
  },
});

const HEX32_PREFIXED = /^0x[0-9a-f]{64}$/;

/// Full check of a prepared artifact: every field the digest and the completion body depend on, and that the
/// message's wallet is the vault the artifact names. Returns problems; empty means usable.
export function validateArtifact(a) {
  const problems = [];
  if (!a || typeof a !== "object" || Array.isArray(a)) return ["artifact is not an object"];
  if (!Number.isSafeInteger(a.chain) || a.chain <= 0) problems.push("chain is not a positive integer");
  if (!ADDR.test(String(a.collection ?? ""))) problems.push("collection is not an address");
  if (!ADDR.test(String(a.vault ?? ""))) problems.push("vault is not an address");
  if (a.code !== null && a.code !== undefined && !CODE.test(String(a.code))) problems.push("code is malformed");
  const m = a.message;
  if (!m || typeof m !== "object" || Array.isArray(m)) return [...problems, "message missing"];
  if (!HEX32_PREFIXED.test(String(m.deviceKey ?? ""))) problems.push("message.deviceKey is not 0x + 64 lowercase hex");
  if (!HEX32_PREFIXED.test(String(m.nonce ?? ""))) problems.push("message.nonce is not 0x + 64 lowercase hex");
  if (typeof m.wallet !== "string" || m.wallet !== String(a.vault ?? "").toLowerCase()) problems.push("message.wallet is not the vault");
  if (!/^\d+$/.test(String(m.tokenId ?? ""))) problems.push("message.tokenId is not a decimal integer");
  if (!Number.isSafeInteger(m.expiresAt) || m.expiresAt <= 0) problems.push("message.expiresAt is not a positive integer");
  if (typeof m.relayOrigin !== "string" || !/^https:\/\/[^\s/]+$/.test(m.relayOrigin)) problems.push("message.relayOrigin is not an https origin");
  return problems;
}

/// The two clocks: the signature's own expiry (message.expiresAt) and IMD's pairing-code expiry (codeExpiresAt,
/// null when the pairing response did not state one). Both must still be ahead to sign or post.
export function expiryProblems(a, nowSeconds) {
  const problems = [];
  if (a.message.expiresAt <= nowSeconds) problems.push("the approved signature expiry has passed: run prepare again and approve the new digest");
  if (a.codeExpiresAt !== null && a.codeExpiresAt !== undefined) {
    const t = parseExpiry(a.codeExpiresAt);
    if (!Number.isFinite(t)) problems.push("codeExpiresAt is not a timestamp");
    else if (t <= nowSeconds * 1000) problems.push("IMD's pairing code expired while the approval was mining: get a fresh code, run prepare again and approve its new digest");
  }
  return problems;
}

function selftest() {
  const expect = {
    relay: API,
    chain: 1,
    collection: "0x0000ec93127baa929e58e97dd0095a2bfb38ec1d",
    token: "2048",
    vault: "0x" + "ab".repeat(20),
  };
  const good = { deviceKey: "aa".repeat(32), nonce: "bb".repeat(32), relayOrigin: API, chainId: 1, nftContract: expect.collection };
  const now = 1_800_000_000_000;
  const goodArtifact = {
    createdAt: 1_800_000_000,
    code: null,
    chain: 1,
    collection: expect.collection,
    vault: expect.vault,
    message: buildMessage(good, expect, 1_800_000_600),
    codeExpiresAt: null,
  };
  const checks = [
    validatePairing(good, expect, now).length === 0,
    validatePairing({ ...good, relayOrigin: "https://evil.example", chainId: 8453, nonce: "zz", consumed: true }, expect, now).length === 4,
    validatePairing("nope", expect, now).length === 1,
    validatePairing({ ...good, expiresAt: "not-a-timestamp" }, expect, now).length === 1,
    validatePairing({ ...good, expiresAt: String(1_799_999_999) }, expect, now).length === 1,
    validatePairing({ ...good, expiresAt: 1_800_000_300 }, expect, now).length === 0,
    validatePairing({ ...good, expiresAt: "2027-02-01T00:00:00Z" }, expect, now).length === 0,
    buildMessage(good, expect, 1_800_000_600).deviceKey === "0x" + "aa".repeat(32),
    buildMessage(good, expect, 1_800_000_600).expiresAt === 1_800_000_600,
    completionBody({ code: "ABCD", message: buildMessage(good, expect, 1) }, "0x01").message.deviceKey === "aa".repeat(32),
    validateArtifact(goodArtifact).length === 0,
    validateArtifact({ ...goodArtifact, message: { ...goodArtifact.message, wallet: "0x" + "cd".repeat(20) } }).length === 1,
    validateArtifact({ ...goodArtifact, message: { ...goodArtifact.message, expiresAt: 1_800_000_600.5 } }).length === 1,
    validateArtifact({ ...goodArtifact, message: { ...goodArtifact.message, nonce: "22".repeat(32) } }).length === 1,
    validateArtifact({ ...goodArtifact, message: undefined }).length === 1,
    expiryProblems(goodArtifact, 1_800_000_000).length === 0,
    expiryProblems({ ...goodArtifact, codeExpiresAt: 1_800_000_300 }, 1_800_000_299).length === 0,
    expiryProblems({ ...goodArtifact, codeExpiresAt: 1_800_000_300 }, 1_800_000_301).length === 1,
    expiryProblems(goodArtifact, 1_800_000_600).length === 1,
  ];
  const pass = checks.every(Boolean);
  console.log(pass ? "selftest ok" : `selftest FAILED: ${JSON.stringify(checks)}`);
  process.exit(pass ? 0 : 1);
}

if (has("--selftest")) selftest();

const phase = args[0];
if (phase !== "prepare" && phase !== "complete") die("usage: pair-vault.mjs prepare|complete ... (see header)");

if (phase === "prepare") {
  const src = args[1];
  const expect = {
    relay: flag("--relay", API),
    chain: Number(flag("--chain", "1")),
    collection: flag("--collection", "0x0000ec93127baa929e58e97dd0095a2bfb38ec1d"),
    token: flag("--token"),
    vault: flag("--vault"),
  };
  const out = flag("--out", "pairing.json");
  if (!src || !expect.token || !/^\d+$/.test(expect.token) || !ADDR.test(expect.vault ?? "")) {
    die("usage: pair-vault.mjs prepare <CODE|fixture.json> --vault 0x... --token <id> [--out pairing.json]");
  }
  if (!Number.isSafeInteger(expect.chain) || expect.chain <= 0) die("--chain must be a positive integer");
  if (!ADDR.test(expect.collection)) die("--collection must be an address");
  const isFixture = src.endsWith(".json");
  let pairing;
  let code = null;
  if (isFixture) {
    pairing = JSON.parse(readFileSync(src, "utf8"));
    if (has("--live")) die("a fixture cannot be used with --live: pass the real pairing code instead");
  } else {
    if (!CODE.test(src)) die("pairing code must be 4-16 alphanumerics");
    if (!has("--live")) die("refusing to contact the live API without --live; pass a fixture .json for a dry run");
    const r = await fetch(`${API}/pair/${src}`, { headers: { accept: "application/json" } });
    if (!r.ok) die(`GET /pair/${src} failed: ${r.status}`, 1);
    pairing = await r.json();
    code = src;
  }
  const problems = validatePairing(pairing, expect);
  if (problems.length) die("pairing response rejected:\n  - " + problems.join("\n  - "), 1);
  const now = Math.floor(Date.now() / 1000);
  let expiresAt;
  if (has("--expires-at")) {
    const raw = flag("--expires-at", "");
    expiresAt = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 3600) {
      die("--expires-at must be an integer Unix time within the next hour");
    }
  } else {
    const raw = flag("--expires", "600");
    const ttl = Number(raw);
    if (!/^\d+$/.test(raw) || !(ttl >= 1 && ttl <= 3600)) {
      die("--expires must be an integer 1..3600 seconds (the vault's MAX_PAIRING_WINDOW)");
    }
    expiresAt = now + ttl;
  }
  const artifact = {
    createdAt: now,
    code,
    chain: expect.chain,
    collection: expect.collection.toLowerCase(),
    vault: expect.vault.toLowerCase(),
    message: buildMessage(pairing, expect, expiresAt),
    codeExpiresAt: pairing.expiresAt ?? null,
  };
  const artifactProblems = validateArtifact(artifact);
  if (artifactProblems.length) die("internal: the artifact failed validation:\n  - " + artifactProblems.join("\n  - "), 1);
  writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
  const m = artifact.message;
  console.log(`artifact written: ${out}`);
  console.log("owner approval to send TO the vault (must be mined before completing; then do not re-run prepare):");
  console.log(`  approvePairing(${m.nonce}, ${m.expiresAt}, ${JSON.stringify(m.relayOrigin)})`);
  console.log(`  device ${m.deviceKey} · wallet ${m.wallet} · token ${m.tokenId} · chain ${artifact.chain}`);
  console.log(`  signature expires at ${m.expiresAt} (${expiresAt - now}s from now); IMD's code expires about 5 minutes after it was printed`);
  let viem = null;
  try {
    viem = await import("viem");
  } catch {}
  if (viem) console.log(`  digest ${viem.hashTypedData(typedData(artifact))} (compare with vault.approvedDigest() after the approval)`);
  else console.log("  digest not computed here (npm i viem to enable); compare vault.approvedDigest() with the relay's digest instead");
  process.exit(0);
}

// complete
const file = args[1];
if (!file) die("usage: pair-vault.mjs complete pairing.json [--sign] [--live]");
const artifact = JSON.parse(readFileSync(file, "utf8"));
const artifactProblems = validateArtifact(artifact);
if (artifactProblems.length) die("artifact rejected:\n  - " + artifactProblems.join("\n  - "), 1);
// both clocks are checked now and again right before anything is posted
const fresh = () => {
  const problems = expiryProblems(artifact, Math.floor(Date.now() / 1000));
  if (problems.length) die(problems.join("\n"), 1);
};
fresh();
const codeNote = artifact.codeExpiresAt === null || artifact.codeExpiresAt === undefined
  ? "code expiry unknown (the pairing response did not state one)"
  : `code expires ${artifact.codeExpiresAt}`;
console.log(`completing pairing for wallet ${artifact.vault}, token ${artifact.message.tokenId}, signature expiresAt ${artifact.message.expiresAt} (from the artifact, not recomputed); ${codeNote}`);
if (!has("--sign")) {
  console.log("dry run: nothing signed, nothing sent (add --sign, and --live to post)");
  process.exit(0);
}
if (!process.env.OPERATOR_KEY) die("--sign needs OPERATOR_KEY in the environment (never printed)");
let viem;
try {
  viem = await import("viem");
} catch {
  die("signing needs viem: npm i viem", 1);
}
const { privateKeyToAccount } = await import("viem/accounts");
const signature = await privateKeyToAccount(process.env.OPERATOR_KEY).signTypedData(typedData(artifact));
console.log(`  digest ${viem.hashTypedData(typedData(artifact))}`);
console.log(`  signature ${signature}`);
if (!has("--live")) {
  console.log("signed, not sent (add --live to POST /pair/complete)");
  process.exit(0);
}
if (!artifact.code || !CODE.test(artifact.code)) die("the artifact has no real pairing code (it came from a fixture); nothing sent", 1);
fresh();
const r = await fetch(`${API}/pair/complete`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(completionBody(artifact, signature)),
});
const text = await r.text();
console.log(r.status, text);
process.exit(r.ok ? 0 : 1);
