// The helper's recovery rules, without a chain: an ambiguous completion (the answer was lost) is reconciled with IMD
// before anything is sent again, and every answer IMD can give maps to exactly one outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Attempt } from '../lib/attempt.js';
import { memoryStore } from './anvil-env.mjs';

const VAULT = '0x' + 'aa'.repeat(20);
const DEVICE = 'ab'.repeat(32);
const NOW = 1_800_000_000_000;
const artifact = { code: 'C0DE', vault: VAULT, message: { deviceKey: '0x' + DEVICE, wallet: VAULT.toLowerCase(), tokenId: '7', expiresAt: NOW / 1000 + 300 }, codeExpiresAt: NOW + 240_000, digest: '0x' + 'dd'.repeat(32) };

function attempt({ status, standing, phase = 'completing', now = NOW }) {
  const store = memoryStore();
  store.save({ phase, vault: VAULT, tokenId: '7', artifact, completion: null, bound: false });
  const imd = {
    pairingStatus: async () => status,
    seatStanding: async () => standing || { ok: false, status: 404, json: null },
    completePairing: async () => { throw new Error('must not be called'); },
  };
  const a = new Attempt({ config: {}, client: {}, imd, operator: {}, store, vault: VAULT, now: () => now });
  return { a, store };
}

test('consumed and enrolled for this vault and seat: completed, nothing re-posted', async () => {
  const { a, store } = attempt({ status: { ok: true, status: 200, json: { consumed: true, enrolled: true, wallet: VAULT.toLowerCase(), tokenId: '7' } } });
  assert.equal(await a.reconcileCompletion(), true);
  assert.equal(store.load().phase, 'completed');
  assert.equal(store.load().completion.status, 'reconciled');
});

test('consumed for another wallet or seat: the attempt is over and never re-posted', async () => {
  const { a, store } = attempt({ status: { ok: true, status: 200, json: { consumed: true, enrolled: true, wallet: '0x' + 'bb'.repeat(20), tokenId: '7' } } });
  await assert.rejects(a.reconcileCompletion(), /consumed but not for this vault and seat/);
  assert.equal(store.load().phase, 'expired');
  await assert.rejects(a.resume(), /expired/);
});

test('not consumed: no completion happened; the record stays where it was', async () => {
  const { a, store } = attempt({ status: { ok: true, status: 200, json: { consumed: false, enrolled: false } } });
  assert.equal(await a.reconcileCompletion(), false);
  assert.equal(store.load().phase, 'completing');
});

test("a code IMD no longer knows: the seat's standing decides, and only a closed window ends the attempt", async () => {
  const gone = { ok: false, status: 404, json: null };
  let r = attempt({ status: gone, standing: { ok: true, status: 200, json: { enrollment: { deviceKey: DEVICE } } } });
  assert.equal(await r.a.reconcileCompletion(), true);
  assert.equal(r.store.load().completion.status, 'reconciled-standing');
  r = attempt({ status: gone, standing: { ok: true, status: 200, json: { enrollment: { deviceKey: 'cd'.repeat(32) } } } });
  await assert.rejects(r.a.reconcileCompletion(), /does not know pairing code .* retry/);
  assert.equal(r.store.load().phase, 'completing', 'still open: the window has time left');
  r = attempt({ status: gone, now: NOW + 600_000 });
  await assert.rejects(r.a.reconcileCompletion(), /window closed without an enrolment/);
  assert.equal(r.store.load().phase, 'expired');
});

test('an unanswered status is retried later, never guessed', async () => {
  const { a, store } = attempt({ status: { ok: false, status: 503, json: { error: 'busy' } } });
  await assert.rejects(a.reconcileCompletion(), /did not answer the pairing status/);
  assert.equal(store.load().phase, 'completing');
});

test('a new pair is refused while a completion is unresolved, however old', async () => {
  const { a } = attempt({ status: { ok: true, status: 200, json: { consumed: false } }, now: NOW + 3_600_000 });
  a.checkVault = async () => ({});
  await assert.rejects(a.start(), /already past the approval .*run resume/);
});
