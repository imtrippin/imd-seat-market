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
const snap = (over = {}) => ({ vault: null, imdSeat: null, artifact: null, pendingHashes: [], agentReusable: null, ...over });
const artifact = { digest: '0x' + 'dd'.repeat(32), message: { expiresAt: NOW + 600 }, codeExpiresAt: (NOW + 300) * 1000, intent: { to: '0x' + '44'.repeat(20), data: '0x' } };

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
  const held = vault({ held: true, seatOwner: V });
  let d = derive(snap({ vault: held }), NOW);
  assert.equal(d.step, 'pair');
  assert.deepEqual(primary(d.owner), ['pairing-offer']);
  d = derive(snap({ vault: held, artifact }), NOW);
  assert.deepEqual(primary(d.owner), ['approvePairing']);
  d = derive(snap({ vault: held, artifact, pendingHashes: ['0x' + '11'.repeat(32)] }), NOW);
  assert.deepEqual(primary(d.owner), []);
  d = derive(snap({ vault: vault({ held: true, seatOwner: V, approvedDigest: artifact.digest, approvedUntil: NOW + 600 }), artifact }), NOW);
  assert.deepEqual(primary(d.owner), [], 'approved: the host completes');
  d = derive(snap({ vault: held, artifact: { ...artifact, message: { expiresAt: NOW - 1 } } }), NOW);
  assert.deepEqual(primary(d.owner), ['pairing-offer'], 'an expired string means a new one');
});

test('registration only when IMD lists the seat without an agent and none is reusable; then hosted; then exit', () => {
  const held = vault({ held: true, seatOwner: V });
  let d = derive(snap({ vault: held, imdSeat: { tokenId: 1, agentId: null }, artifact }), NOW);
  assert.equal(d.step, 'register');
  assert.deepEqual(primary(d.owner), ['registerAgent']);
  d = derive(snap({ vault: held, imdSeat: { tokenId: 1, agentId: null }, artifact: { ...artifact, intent: null } }), NOW);
  assert.deepEqual(primary(d.owner), ['pairing-offer'], 'no intent in hand: ask for the string again');
  d = derive(snap({ vault: held, imdSeat: { tokenId: 1, agentId: null }, agentReusable: true }), NOW);
  assert.equal(d.step, 'hosted', 'a reusable agent needs no registration');
  d = derive(snap({ vault: held, imdSeat: { tokenId: 1, agentId: '51760' } }), NOW);
  assert.equal(d.step, 'hosted');
  assert.ok(all(d.owner).includes('withdraw'));
  d = derive(snap({ vault: vault({ held: true, seatOwner: V, ended: true, endedAt: NOW, pending: '5' }) }), NOW);
  assert.equal(d.step, 'exit');
  assert.ok(primary(d.owner).includes('withdraw') && all(d.owner).includes('claim') && all(d.host).includes('claim'));
  d = derive(snap({ vault: vault({ held: false, seatOwner: OWNER, ended: true, endedAt: NOW, claimableProvider: '3' }) }), NOW);
  assert.equal(d.step, 'exit');
  assert.equal(d.statuses[STEPS.length - 1].status, 'done');
  assert.ok(all(d.host).includes('claim'), 'the host claims after the exit');
  assert.equal(primary(d.owner).length, 0);
});
