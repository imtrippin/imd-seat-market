import test from 'node:test';
import assert from 'node:assert/strict';
import { derive, STEPS } from '../lib/steps.js';

const V = '0x' + 'aa'.repeat(20);
const OWNER = '0x' + '11'.repeat(20);
const HOST = '0x' + '22'.repeat(20);
const DEVICE = '0x' + 'ab'.repeat(32);
const NOW = 1_800_000_000;
const zero32 = '0x' + '0'.repeat(64);

const vault = (over = {}) => ({
  address: V, owner: OWNER, provider: HOST, operator: '0x' + '33'.repeat(20), tokenId: '1', providerBps: 3000, deviceKey: DEVICE,
  held: false, ended: false, endedAt: 0, approvedDigest: zero32, approvedUntil: 0, accounted: '0', pending: '0', shortfall: '0',
  claimableOwner: '0', claimableProvider: '0', seatOwner: OWNER, rewardBalance: '0', ...over,
});
const primary = (list) => list.filter((a) => !a.passive && !a.secondary).map((a) => a.id);
const all = (list) => list.filter((a) => !a.passive).map((a) => a.id);
const snap = (over = {}) => ({ vault: null, artifact: null, approved: null, intent: null, registered: null, pendingHashes: [], imdSeat: null, agentReusable: null, ...over });
const artifact = { digest: '0x' + 'dd'.repeat(32), code: 'A1B2', message: { expiresAt: NOW + 600 }, codeExpiresAt: (NOW + 300) * 1000 };
const intent = { to: '0x' + '44'.repeat(20), data: '0xb68ca002' };
const held = vault({ held: true, seatOwner: V });

test('create, then one safe transfer moves the NFT in', () => {
  assert.equal(derive(snap(), NOW).step, 'create');
  let d = derive(snap({ vault: vault() }), NOW);
  assert.equal(d.step, 'deposit');
  assert.deepEqual(primary(d.owner), ['deposit']);
  d = derive(snap({ vault: vault({ seatOwner: V }) }), NOW);
  assert.deepEqual(primary(d.owner), ['syncHeld']);
  assert.ok(all(d.owner).includes('withdraw'), 'a plain-transferred NFT can always be taken back');
  d = derive(snap({ vault: vault({ seatOwner: '0x' + '99'.repeat(20) }) }), NOW);
  assert.deepEqual(primary(d.owner), []);
  assert.equal(d.notes.length, 1);
});

test('pairing: paste, approve once, then wait; a pending approval blocks a second one', () => {
  let d = derive(snap({ vault: held }), NOW);
  assert.equal(d.step, 'pair');
  assert.deepEqual(primary(d.owner), ['pairing-offer']);
  d = derive(snap({ vault: held, artifact }), NOW);
  assert.deepEqual(primary(d.owner), ['approvePairing']);
  d = derive(snap({ vault: held, artifact, pendingHashes: ['0x' + '11'.repeat(32)] }), NOW);
  assert.deepEqual(primary(d.owner), []);
  d = derive(snap({ vault: vault({ held: true, seatOwner: V, approvedDigest: artifact.digest, approvedUntil: NOW + 600 }), artifact }), NOW);
  assert.notEqual(d.step, 'pair', 'a live approval of the current string ends the pairing step');
});

test('an old IMD listing never skips the new pairing (Codex R2)', () => {
  const oldListing = { tokenId: 1, agentId: '19', accepted: 300 };
  let d = derive(snap({ vault: held, imdSeat: oldListing, agentReusable: true }), NOW);
  assert.equal(d.step, 'pair', 'a reusable agent skips only the registration');
  assert.deepEqual(primary(d.owner), ['pairing-offer']);
  d = derive(snap({ vault: held, imdSeat: oldListing, agentReusable: false, artifact }), NOW);
  assert.equal(d.step, 'pair');
  assert.deepEqual(primary(d.owner), ['approvePairing']);
  // after the owner's approval was mined: reusable → done; not reusable → register; unknown → wait, never pay twice
  const approved = { digest: artifact.digest, code: 'A1B2' };
  d = derive(snap({ vault: held, imdSeat: oldListing, agentReusable: true, approved }), NOW);
  assert.equal(d.step, 'done');
  d = derive(snap({ vault: held, imdSeat: oldListing, agentReusable: false, approved, intent }), NOW);
  assert.equal(d.step, 'register');
  assert.deepEqual(primary(d.owner), ['registerAgent']);
  d = derive(snap({ vault: held, imdSeat: oldListing, agentReusable: null, approved, intent }), NOW);
  assert.equal(d.step, 'register');
  assert.deepEqual(primary(d.owner), [], 'unknown reuse: no registration is offered');
  assert.ok(d.notes.some((n) => n.includes('could not be checked')));
});

test('registration survives the pairing deadline: the kept intent, not the string, gates it (Codex R3)', () => {
  const approved = { digest: artifact.digest, code: 'A1B2' };
  // the string expired (artifact null) but the approval was mined and the intent was kept
  let d = derive(snap({ vault: held, artifact: null, approved, intent, imdSeat: null }), NOW + 3600);
  assert.equal(d.step, 'register');
  assert.deepEqual(primary(d.owner), ['registerAgent']);
  d = derive(snap({ vault: held, artifact: null, approved, intent: null }), NOW + 3600);
  assert.deepEqual(primary(d.owner), ['pairing-offer'], 'no intent in hand: ask for the string again');
  // the owner's registration mined: done, whatever IMD lists
  d = derive(snap({ vault: held, approved, intent, registered: { agentId: '7' }, imdSeat: null }), NOW + 3600);
  assert.equal(d.step, 'done');
  assert.ok(d.notes[0].includes('Your host confirms'));
});

test('a new pairing string after an approval starts the pairing again', () => {
  const approved = { digest: artifact.digest, code: 'A1B2' };
  const fresh = { ...artifact, digest: '0x' + 'ee'.repeat(32), code: 'C3D4' };
  const d = derive(snap({ vault: held, approved, artifact: fresh }), NOW);
  assert.equal(d.step, 'pair');
  assert.deepEqual(primary(d.owner), ['approvePairing']);
});

test('exit and claims after exit', () => {
  let d = derive(snap({ vault: vault({ held: true, seatOwner: V, ended: true, endedAt: NOW, pending: '5' }) }), NOW);
  assert.equal(d.step, 'exit');
  assert.ok(primary(d.owner).includes('withdraw') && all(d.owner).includes('claim') && all(d.host).includes('claim'));
  d = derive(snap({ vault: vault({ held: false, seatOwner: OWNER, ended: true, endedAt: NOW, claimableProvider: '3' }) }), NOW);
  assert.equal(d.step, 'exit');
  assert.equal(d.statuses[STEPS.length - 1].status, 'done');
  assert.ok(all(d.host).includes('claim'), 'the host claims after the exit');
  assert.equal(primary(d.owner).length, 0);
});
