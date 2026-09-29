// Offline checks of the vault pairing script and the testnet walkthrough. Adopted from Codex's review probes.
// No keys, signatures, network requests or transactions: fixtures, a frozen clock and command shims only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, chmodSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const pairingScript = resolve(here, "../contracts/script/pair-vault.mjs");
const fixture = resolve(here, "../contracts/script/pair-fixture.example.json");
const walkthrough = resolve(here, "../contracts/script/testnet-walkthrough.sh");
const fakeVault = "0x" + "ab".repeat(20);
const T0 = 1_800_000_000;

function scratch(work) {
  const folder = mkdtempSync(join(here, ".pair-scratch-"));
  try {
    return work(folder);
  } finally {
    const absolute = resolve(folder);
    if (!absolute.startsWith(resolve(here) + sep) || !absolute.includes(".pair-scratch-")) throw new Error("refusing cleanup outside test dir");
    rmSync(absolute, { recursive: true, force: true });
  }
}

function run(now, extra, cwd) {
  const clock = "data:text/javascript," + encodeURIComponent(`Date.now = () => ${now * 1000};`);
  return spawnSync(process.execPath, ["--import", clock, pairingScript, ...extra], { encoding: "utf8", timeout: 15000, cwd });
}

test("selftest passes", () => {
  const r = spawnSync(process.execPath, [pairingScript, "--selftest"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("prepare then complete keeps the exact approved expiry across runs", () =>
  scratch((folder) => {
    const out = join(folder, "pairing.json");
    const prep = run(T0, ["prepare", fixture, "--vault", fakeVault, "--token", "2048", "--out", out], folder);
    assert.equal(prep.status, 0, prep.stdout + prep.stderr);
    const artifact = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(artifact.message.expiresAt, T0 + 600);
    assert.match(prep.stdout, /approvePairing\(0x2{64}, 1800000600, "https:\/\/api\.imd\.fun"\)/);
    const done = run(T0 + 12, ["complete", out], folder);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /expiresAt 1800000600 \(from the artifact, not recomputed\)/);
    assert.match(done.stdout, /dry run: nothing signed, nothing sent/);
  }));

test("complete refuses an artifact whose approved expiry has passed", () =>
  scratch((folder) => {
    const out = join(folder, "pairing.json");
    run(T0, ["prepare", fixture, "--vault", fakeVault, "--token", "2048", "--out", out], folder);
    const late = run(T0 + 601, ["complete", out], folder);
    assert.notEqual(late.status, 0);
    assert.match(late.stderr, /expiry has passed/);
  }));

test("prepare rejects an invalid or expired pairing-code timestamp and a mismatched token", () =>
  scratch((folder) => {
    const base = JSON.parse(readFileSync(fixture, "utf8"));
    for (const [name, patch] of [
      ["invalid", { expiresAt: "not-a-timestamp" }],
      ["expired-string", { expiresAt: String(T0 - 1) }],
      ["expired-number", { expiresAt: T0 - 1 }],
      ["wrong-token", { tokenId: "7" }],
    ]) {
      const path = join(folder, `${name}.json`);
      writeFileSync(path, JSON.stringify({ ...base, ...patch }));
      const r = run(T0, ["prepare", path, "--vault", fakeVault, "--token", "2048", "--out", join(folder, "x.json")], folder);
      assert.notEqual(r.status, 0, `${name} was accepted`);
    }
    const ok = JSON.parse(readFileSync(fixture, "utf8"));
    ok.expiresAt = T0 + 300;
    const path = join(folder, "ok.json");
    writeFileSync(path, JSON.stringify(ok));
    const r = run(T0, ["prepare", path, "--vault", fakeVault, "--token", "2048", "--out", join(folder, "y.json")], folder);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }));

test("a fixture cannot be combined with --live, and a code needs --live", () =>
  scratch((folder) => {
    const a = run(T0, ["prepare", fixture, "--vault", fakeVault, "--token", "2048", "--live", "--out", join(folder, "a.json")], folder);
    assert.notEqual(a.status, 0);
    const b = run(T0, ["prepare", "ABCD1234", "--vault", fakeVault, "--token", "2048", "--out", join(folder, "b.json")], folder);
    assert.notEqual(b.status, 0);
    assert.match(b.stderr, /refusing to contact the live API/);
  }));

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const bashPath = (p) => p.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, d) => "/" + d.toLowerCase());

test("walkthrough refuses a non-testnet chain before reading keys or sending anything", { skip: !existsSync(bash) }, () =>
  scratch((folder) => {
    const journal = join(folder, "calls.txt");
    writeFileSync(join(folder, "cast"), `#!/usr/bin/env bash
if [ "$1" = "chain-id" ]; then printf 'chain-id\\n' >> "$REVIEW_JOURNAL"; echo 1; exit 0; fi
if [ "$1" = "send" ]; then printf 'send\\n' >> "$REVIEW_JOURNAL"; echo 'offline shim'; exit 1; fi
exit 1
`);
    writeFileSync(join(folder, "python"), `#!/usr/bin/env bash
printf 'key-read\\n' >> "$REVIEW_JOURNAL"
echo '0x0000000000000000000000000000000000000001'
`);
    writeFileSync(join(folder, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
    for (const f of ["cast", "python", "sleep"]) chmodSync(join(folder, f), 0o755);
    const r = spawnSync(bash, ["--noprofile", "--norc", "-c", 'export PATH="$REVIEW_BIN:$PATH"; exec bash "$REVIEW_SCRIPT" "$A" "$A" "$A" https://review.invalid/chain-1'], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, REVIEW_BIN: bashPath(folder), REVIEW_SCRIPT: bashPath(walkthrough), REVIEW_JOURNAL: bashPath(journal), A: fakeVault, KEYS: bashPath(folder), SETTLE: "0" },
    });
    assert.notEqual(r.status, 0, "walkthrough did not refuse chain 1");
    const calls = existsSync(journal) ? readFileSync(journal, "utf8").trim().split(/\r?\n/) : [];
    assert.ok(calls.includes("chain-id"), `chain was not checked: ${JSON.stringify(calls)}`);
    assert.ok(!calls.includes("send") && !calls.includes("key-read"), `keys read or send attempted: ${JSON.stringify(calls)}`);
  }));

test("complete refuses when IMD's pairing code expired while the approval was mining", () =>
  scratch((folder) => {
    const pairing = JSON.parse(readFileSync(fixture, "utf8"));
    pairing.expiresAt = T0 + 300;
    const source = join(folder, "fixture.json");
    const out = join(folder, "artifact.json");
    writeFileSync(source, JSON.stringify(pairing));
    assert.equal(run(T0, ["prepare", source, "--vault", fakeVault, "--token", "2048", "--out", out], folder).status, 0);
    const artifact = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(artifact.codeExpiresAt, T0 + 300);
    assert.equal(artifact.message.expiresAt, T0 + 600);
    assert.equal(run(T0 + 299, ["complete", out], folder).status, 0);
    const late = run(T0 + 301, ["complete", out], folder);
    assert.notEqual(late.status, 0);
    assert.match(late.stderr, /pairing code expired/);
  }));

test("complete refuses a pairing code that expired earlier in the current second", () =>
  scratch((folder) => {
    const pairing = JSON.parse(readFileSync(fixture, "utf8"));
    pairing.expiresAt = (T0 + 300) * 1000 + 100; // millisecond deadline inside second T0+300
    const source = join(folder, "fixture.json");
    const out = join(folder, "artifact.json");
    writeFileSync(source, JSON.stringify(pairing));
    assert.equal(run(T0, ["prepare", source, "--vault", fakeVault, "--token", "2048", "--out", out], folder).status, 0);
    assert.equal(run(T0 + 300.099, ["complete", out], folder).status, 0, "1 ms before the deadline is still fresh");
    const late = run(T0 + 300.9, ["complete", out], folder);
    assert.notEqual(late.status, 0, "800 ms after the deadline must be refused");
    assert.match(late.stderr, /pairing code expired/);
  }));

test("prepare refuses a fractional or non-integer signature TTL", () =>
  scratch((folder) => {
    for (const ttl of ["600.5", "1e3", "-5", "0", "3601", "abc"]) {
      const r = run(T0, ["prepare", fixture, "--vault", fakeVault, "--token", "2048", "--expires", ttl, "--out", join(folder, "a.json")], folder);
      assert.notEqual(r.status, 0, `ttl ${ttl} was accepted`);
    }
    const bad = run(T0, ["prepare", fixture, "--vault", fakeVault, "--token", "2048", "--expires-at", String(T0 + 600.5), "--out", join(folder, "b.json")], folder);
    assert.notEqual(bad.status, 0);
  }));

test("the artifact has exactly the expected shape and a tampered wallet is refused at completion", () =>
  scratch((folder) => {
    const out = join(folder, "artifact.json");
    assert.equal(run(T0, ["prepare", fixture, "--vault", fakeVault, "--token", "2048", "--out", out], folder).status, 0);
    const artifact = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(Object.keys(artifact).sort(), ["chain", "code", "codeExpiresAt", "collection", "createdAt", "message", "vault"]);
    assert.deepEqual(Object.keys(artifact.message).sort(), ["deviceKey", "expiresAt", "nonce", "relayOrigin", "tokenId", "wallet"]);
    artifact.message.wallet = "0x" + "cd".repeat(20);
    writeFileSync(out, JSON.stringify(artifact));
    const r = run(T0 + 1, ["complete", out], folder);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /message\.wallet is not the vault/);
  }));

// The walkthrough's send/receipt helpers, extracted unchanged and run against command shims: no key is loaded, no
// lifecycle step runs, nothing is signed or broadcast. The shims simulate a transaction that executed although the
// node answered with an error, a lagging replica that never shows its receipt, a node that returns another
// transaction's receipt, and a failed nonce read. The receipt parser is the real Python one when an interpreter is
// available (REVIEW_PYTHON, python3 or python); otherwise a stub prints a bare status and the hash-check scenarios skip.
// The receipt parser is the real Python one when an interpreter is available. REVIEW_PYTHON wins; otherwise
// python3/python are asked for their own absolute path, so the harness's `python` shim can never exec itself.
function findPython() {
  if (process.env.REVIEW_PYTHON) return process.env.REVIEW_PYTHON;
  for (const c of ["python3", "python"]) {
    const r = spawnSync(c, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", timeout: 10000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
const realPython = findPython();
function sendScenario(folder, scenario) {
  const source = readFileSync(walkthrough, "utf8");
  const start = source.indexOf("receipt() {");
  const end = source.indexOf("call() {", start);
  assert.ok(start >= 0 && end > start, "walkthrough helpers not found");
  writeFileSync(join(folder, "harness.sh"), `#!/usr/bin/env bash\nset -euo pipefail\nRPC=https://review.invalid\nSETTLE=0\n${source.slice(start, end)}\nsend PUBLIC_REVIEW_MARKER token 'transfer(address,uint256)' recipient 100\n`);
  writeFileSync(join(folder, "cast"), `#!/usr/bin/env bash
case "$1" in
  wallet) echo 0x1111111111111111111111111111111111111111 ;;
  nonce)
    if [ "$REVIEW_SCENARIO" = nonce-error ]; then echo unavailable >&2; exit 1; fi
    if [ -f "$REVIEW_DIR/mined0" ]; then echo 1; else echo 0; fi ;;
  mktx)
    nonce=missing
    while [ "$#" -gt 0 ]; do if [ "$1" = --nonce ]; then shift; nonce="$1"; fi; shift; done
    echo "build $nonce" >> "$REVIEW_DIR/journal"
    echo "raw$nonce" ;;
  keccak) echo "hash-$2" ;;
  publish)
    for arg in "$@"; do raw="$arg"; done
    echo "publish $raw" >> "$REVIEW_DIR/journal"
    if [ "$raw" = raw0 ]; then
      if [ ! -f "$REVIEW_DIR/mined0" ]; then echo execution >> "$REVIEW_DIR/journal"; touch "$REVIEW_DIR/mined0"; fi
      case "$REVIEW_SCENARIO" in
        nonce) echo 'nonce too low'; exit 1 ;;
        transport) echo 'transport disconnected'; exit 1 ;;
        reverted) echo hash-raw0 ;;
      esac
    else echo execution >> "$REVIEW_DIR/journal"; echo hash-raw1; fi ;;
  receipt)
    for arg in "$@"; do hash="$arg"; done
    if [ "$REVIEW_SCENARIO" = reverted ]; then echo "{\\"transactionHash\\":\\"$hash\\",\\"status\\":\\"0x0\\",\\"blockNumber\\":\\"0x1\\"}";
    elif [ "$REVIEW_SCENARIO" = wrong-receipt ]; then echo '{"transactionHash":"other-hash","status":"0x1","blockNumber":"0x1"}';
    elif [ "$hash" = hash-raw0 ]; then echo null;
    else echo "{\\"transactionHash\\":\\"$hash\\",\\"status\\":\\"0x1\\",\\"blockNumber\\":\\"0x1\\"}"; fi ;;
  *) exit 99 ;;
esac
`);
  // the real parser when an interpreter exists; the bare-status stub otherwise (it cannot check the hash)
  writeFileSync(join(folder, "python"), realPython
    ? `#!/usr/bin/env bash\nexec "$REVIEW_PYTHON" "$@"\n`
    : `#!/usr/bin/env bash\nif [ "$REVIEW_SCENARIO" = reverted ]; then echo 0x0; else echo 0x1; fi\n`);
  writeFileSync(join(folder, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  for (const name of ["cast", "python", "sleep", "harness.sh"]) chmodSync(join(folder, name), 0o755);
  const result = spawnSync(bash, ["--noprofile", "--norc", "-c", 'export PATH="$REVIEW_DIR:$PATH"; exec bash "$REVIEW_DIR/harness.sh"'], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, REVIEW_DIR: bashPath(folder), REVIEW_SCENARIO: scenario, ...(realPython ? { REVIEW_PYTHON: bashPath(realPython) } : {}) },
  });
  assert.equal(result.error, undefined);
  // a run that stops before any build or publish leaves no journal at all
  const journal = existsSync(join(folder, "journal")) ? readFileSync(join(folder, "journal"), "utf8").trim().split(/\r?\n/) : [];
  return { ...result, journal };
}

for (const scenario of ["nonce", "transport"]) {
  test(`walkthrough send never rebuilds a call with another nonce (${scenario} ambiguity)`, { skip: !existsSync(bash) }, () =>
    scratch((folder) => {
      const r = sendScenario(folder, scenario);
      assert.equal(r.journal.filter((l) => l === "execution").length, 1, "executed more than once: " + r.journal.join(", "));
      assert.equal(r.journal.filter((l) => l.startsWith("build")).length, 1, "rebuilt: " + r.journal.join(", "));
      assert.notEqual(r.status, 0, "a missing receipt must not be reported as success");
      assert.match(r.stdout, /no receipt/);
    }));
}

test("walkthrough send treats a status-0 receipt as failure without rebuilding", { skip: !existsSync(bash) }, () =>
  scratch((folder) => {
    const r = sendScenario(folder, "reverted");
    assert.notEqual(r.status, 0);
    assert.equal(r.journal.filter((l) => l.startsWith("build")).length, 1);
    assert.match(r.stdout, /transaction reverted/);
  }));

// Round three (2026-09-28): a success receipt for another hash is not a confirmation, and a failed nonce read
// never reaches signing (an empty --nonce would sign as nonce zero).
test("walkthrough send rejects a status-1 receipt that belongs to another transaction", { skip: !existsSync(bash) || !realPython }, () =>
  scratch((folder) => {
    const r = sendScenario(folder, "wrong-receipt");
    assert.notEqual(r.status, 0, "a receipt for another hash was accepted as success");
    assert.equal(r.journal.filter((l) => l.startsWith("build")).length, 1, "rebuilt: " + r.journal.join(", "));
    assert.match(r.stdout, /belongs to another transaction/);
  }));

test("walkthrough send stops before signing when the nonce read fails", { skip: !existsSync(bash) }, () =>
  scratch((folder) => {
    const r = sendScenario(folder, "nonce-error");
    assert.notEqual(r.status, 0, "a failed nonce read was turned into a send");
    assert.equal(r.journal.filter((l) => l.startsWith("build") || l.startsWith("publish")).length, 0, "signed or published without a nonce: " + r.journal.join(", "));
    assert.match(r.stderr + r.stdout, /nonce read for .* failed/);
  }));
