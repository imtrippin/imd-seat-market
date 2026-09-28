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
