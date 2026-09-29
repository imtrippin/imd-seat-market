import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Rooms, PRESENCE_MS, READY_MS } from '../lib/rooms.js';
import { Setup } from '../lib/setup.js';
import { validateConfig } from '../lib/config.js';
import { calendarEvent, remaining } from '../public/setup.js';
import { encodeOffer, PAIRING_PREFIX } from '../lib/pairing.js';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

// Public deterministic fixture keys, never usable with real value.
const owner = privateKeyToAccount('0x' + '01'.repeat(32));
const host = privateKeyToAccount('0x' + '02'.repeat(32));
const outsider = privateKeyToAccount('0x' + '03'.repeat(32));
const addr = (n) => '0x' + n.repeat(40);
function fixture() {
  let clock = 1_900_000_000_000, resolved = false;
  const config = { chainId: 31337, setupUrl: 'https://setup.invalid', collection: addr('a'), rewardToken: addr('b'), registrar: addr('c'), relayOrigin: 'https://relay.invalid' };
  const vault = { ...config, address: addr('d'), owner: owner.address, provider: host.address, operator: addr('e'), held: true, ended: false, seatOwner: addr('d'), tokenId: '1', deviceKey: '0x' + 'ab'.repeat(32) };
  const rooms = new Rooms({ config, now: () => clock, lookup: async () => vault, verify: (address, message, signature) => verifyMessage({ address, message, signature }), receipt: async () => resolved });
  const join = async (account) => { const c = await rooms.challenge({ vault: vault.address, account: account.address }); return rooms.join({ nonce: c.nonce, signature: await account.signMessage({ message: c.message }) }); };
  return { rooms, config, vault, join, advance: (ms) => clock += ms, time: () => clock, resolve: () => { resolved = true; } };
}
test('rooms authenticate both roles, reject strangers and consume sign-in nonces', async () => {
  const f = fixture();
  await assert.rejects(f.join(outsider), /Only the NFT owner/);
  const c = await f.rooms.challenge({ vault: f.vault.address, account: owner.address });
  await assert.rejects(f.rooms.join({ nonce: c.nonce, signature: await host.signMessage({ message: c.message }) }), /not valid/);
  await assert.rejects(f.rooms.join({ nonce: c.nonce, signature: await owner.signMessage({ message: c.message }) }), /expired/);
  const a = await f.join(owner); assert.equal(a.role, 'owner');
  const b = await f.join(host); assert.equal(b.role, 'host');
  assert.equal((await f.rooms.act(a.token, 'state')).parties.host.online, true);
});
test('no code reservation before both explicit ready checks; ready is consumed once', async () => {
  const f = fixture(), a = await f.join(owner), b = await f.join(host);
  await assert.rejects(f.rooms.act(b.token, 'begin'), /Both people/);
  await f.rooms.act(a.token, 'ready', { ready: true, version: 0 });
  await assert.rejects(f.rooms.act(b.token, 'begin'), /Both people/);
  await f.rooms.act(b.token, 'ready', { ready: true, version: 0 });
  const results = await Promise.allSettled([f.rooms.act(b.token, 'begin'), f.rooms.act(b.token, 'begin')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await f.rooms.act(a.token, 'state')).bothReady, false);
});
test('presence expiry, leaving, and absolute readiness timeout all invalidate readiness', async () => {
  const f = fixture(), a = await f.join(owner), b = await f.join(host);
  await f.rooms.act(a.token, 'ready', { ready: true, version: 0 });
  await f.rooms.act(b.token, 'ready', { ready: true, version: 0 });
  f.advance(PRESENCE_MS);
  assert.equal((await f.rooms.act(a.token, 'state')).bothReady, false);
  await f.rooms.act(a.token, 'heartbeat', { active: true });
  assert.equal((await f.rooms.act(a.token, 'state')).parties.owner.ready, false, 'returning after presence expiry requires a new ready click');
  await f.rooms.act(b.token, 'heartbeat', { active: false });
  assert.equal((await f.rooms.act(a.token, 'state')).parties.host.ready, false);
  f.advance(READY_MS);
  await f.rooms.act(a.token, 'heartbeat', { active: true });
  assert.equal((await f.rooms.act(a.token, 'state')).parties.owner.ready, false);
});
test('rescheduling requires fresh confirmation and clears readiness', async () => {
  const f = fixture(), a = await f.join(owner), b = await f.join(host);
  await f.rooms.act(a.token, 'ready', { ready: true, version: 0 });
  const r = await f.rooms.act(b.token, 'schedule', { at: f.time() + 5 * 60000 });
  assert.equal(r.parties.owner.ready, false);
  await assert.rejects(f.rooms.act(a.token, 'ready', { ready: true, version: 0 }), /changed/);
  await assert.rejects(f.rooms.act(a.token, 'ready', { ready: true, version: 1 }), /Confirm/);
  await f.rooms.act(a.token, 'accept', { version: 1 });
  assert.equal((await f.rooms.act(a.token, 'ready', { ready: true, version: 1 })).parties.owner.ready, true);
});
test('an expired attempt cannot be retried with an unresolved approval transaction', async () => {
  const f = fixture(), a = await f.join(owner), b = await f.join(host);
  const ready = async () => { for (const x of [a, b]) { await f.rooms.act(x.token, 'heartbeat', { active: true }); await f.rooms.act(x.token, 'ready', { ready: true, version: 0 }); } };
  await ready(); const first = await f.rooms.act(b.token, 'begin');
  await f.rooms.act(a.token, 'pending', { attemptId: first.attempt.id, hash: '0x' + 'ab'.repeat(32) });
  f.advance(61000); await ready();
  await assert.rejects(f.rooms.act(b.token, 'begin'), /unresolved/);
  f.resolve(); const next = await f.rooms.act(b.token, 'begin');
  assert.notEqual(next.attempt.id, first.attempt.id);
});
test('sign-in expiry and a second sign-in invalidate stale sessions', async () => {
  const f = fixture(), a = await f.join(owner);
  await f.join(owner); await assert.rejects(f.rooms.act(a.token, 'state'), /sign-in expired/);
  const c = await f.rooms.challenge({ vault: f.vault.address, account: owner.address });
  f.advance(120000);
  await assert.rejects(f.rooms.join({ nonce: c.nonce, signature: await owner.signMessage({ message: c.message }) }), /expired/);
});
test('the local console refuses arbitrary sign-in text from a compromised coordinator', async () => {
  const f = fixture();
  const s = new Setup({ snapshot: f.vault, config: f.config });
  s.request = async () => ({ nonce: 'ab'.repeat(24), until: Date.now() + 60000, role: 'owner', message: 'Sign unrelated authority' });
  await assert.rejects(s.act('challenge', { account: owner.address }), /does not match/);
});
test('calendar is timezone-independent UTC and countdown stops at zero', () => {
  const value = calendarEvent({ at: Date.parse('2026-10-01T14:00:00-04:00'), vault: addr('d'), chainId: 31337, version: 1 });
  assert.match(value, /DTSTART:20261001T180000Z/);
  assert.match(value, /TRIGGER:-PT10M/);
  assert.equal(remaining(300000, 0), '5:00'); assert.equal(remaining(100, 200), '0:00');
});
test('remote coordinator configuration requires HTTPS and refuses URL credentials', () => {
  assert.ok(validateConfig({ setupUrl: 'http://public.invalid' }).some((s) => s.includes('setupUrl')));
  assert.ok(validateConfig({ setupUrl: 'https://user:secret@public.invalid' }).some((s) => s.includes('setupUrl')));
  assert.ok(!validateConfig({ setupUrl: 'http://127.0.0.1:18821' }).some((s) => s.includes('setupUrl')));
});
test('only the host publishes an offer and wrong-vault or stale offers never reach the room', async () => {
  const f = fixture(), a = await f.join(owner), b = await f.join(host);
  for (const x of [a, b]) await f.rooms.act(x.token, 'ready', { ready: true, version: 0 });
  const r = await f.rooms.act(b.token, 'begin');
  const artifact = { code: 'ABCD2345', vault: f.vault.address, collection: f.config.collection, chain: f.config.chainId,
    message: { deviceKey: f.vault.deviceKey, wallet: f.vault.address, tokenId: '1', nonce: '0x' + '12'.repeat(32), expiresAt: Math.floor(f.time() / 1000) + 300, relayOrigin: f.config.relayOrigin }, codeExpiresAt: f.time() + 300000 };
  const publish = (x, data) => f.rooms.act(x.token, 'offer', { attemptId: r.attempt.id, offer: encodeOffer(PAIRING_PREFIX, data) });
  await assert.rejects(publish(a, artifact), /reservation expired/);
  await assert.rejects(publish(b, { ...artifact, vault: addr('f') }), /match/);
  await assert.rejects(publish(b, { ...artifact, codeExpiresAt: f.time() + 59000 }), /enough verified time/);
  const good = await publish(b, artifact); assert.equal(good.attempt.phase, 'offered');
  await assert.rejects(publish(b, artifact), /reservation expired/);
});
test('a restart keeps the appointment but never restores readiness or login tokens', async () => {
  const f = fixture(), a = await f.join(owner), dir = mkdtempSync(pathJoin(tmpdir(), 'seat-room-test-'));
  const file = pathJoin(dir, 'rooms.json'); f.rooms.file = file;
  try {
    await f.rooms.act(a.token, 'schedule', { at: f.time() + 120000 });
    await f.rooms.act(a.token, 'ready', { ready: true, version: 1 });
    const restored = new Rooms({ config: f.config, lookup: f.rooms.lookup, verify: f.rooms.verify, receipt: f.rooms.receipt, now: f.time, file });
    const state = restored.view(restored.rooms.get(f.vault.address));
    assert.equal(state.schedule.at, f.time() + 120000); assert.equal(state.parties.owner.ready, false);
    await assert.rejects(restored.act(a.token, 'state'), /expired/);
  } finally { unlinkSync(file); rmdirSync(dir); }
});
test('disarming while a chain read is pending prevents automatic pairing', async () => {
  let done; const waiting = new Promise((resolve) => { done = resolve; }); let started = false;
  const s = { config: {}, snapshot: { held: true }, refresh: () => waiting, startPairing: async () => { started = true; } };
  const setup = new Setup(s); setup.auth = { token: 'fixture', role: 'host' }; setup.armedUntil = Date.now() + 60000;
  setup.request = async () => ({});
  const task = setup.tick(); setup.clear(); done(); await task;
  assert.equal(started, false);
});
test('an automatic stop reason survives a successful room refresh', async () => {
  const s = { config: {}, snapshot: { held: true, ended: true }, refresh: async () => {} };
  const setup = new Setup(s); setup.auth = { token: 'fixture', role: 'host' }; setup.armedUntil = Date.now() + 60000;
  await setup.tick();
  assert.match(setup.view().error, /Automatic setup paused/);
  setup.request = async () => ({ attempt: null });
  await setup.refresh();
  assert.match(setup.view().error, /Automatic setup paused/);
  assert.equal(setup.armedUntil, 0);
});
