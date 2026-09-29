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
  claimableOwner: '0', claimableProvider: '0', seatOwner: OWNER, seatApproved: '0x' + '0'.repeat(40), rewardBalance: '0', ...over,
});
const ids = (list) => list.filter((a) => !a.passive && !a.secondary).map((a) => a.id); // primary actions
const all = (list) => list.filter((a) => !a.passive).map((a) => a.id);
const snap = (over = {}) => ({ vault: null, imd: {}, pairing: { phase: 'none' }, registration: {}, hostingOffer: null, ...over });

test('no vault: the host publishes an offer, the owner creates', () => {
  const d = derive(snap(), NOW);
  assert.equal(d.step, 'create');
  assert.deepEqual(ids(d.host), ['hosting-offer']);
  assert.deepEqual(d.owner[0].needs, ['hosting-offer']);
  assert.deepEqual(derive(snap({ hostingOffer: {} }), NOW).owner[0].needs, []);
});

test('deposit: approve then deposit, or record a plain transfer', () => {
  let d = derive(snap({ vault: vault() }), NOW);
  assert.equal(d.step, 'deposit');
  assert.deepEqual(ids(d.owner), ['approveSeat', 'deposit']);
  d = derive(snap({ vault: vault({ seatApproved: V }) }), NOW);
  assert.deepEqual(ids(d.owner), ['deposit']);
  d = derive(snap({ vault: vault({ seatOwner: V }) }), NOW);
  assert.deepEqual(ids(d.owner), ['syncHeld']);
  assert.ok(all(d.owner).includes('withdraw'), 'a plain-transferred seat can always be taken back');
  d = derive(snap({ vault: vault({ seatOwner: '0x' + '99'.repeat(20) }) }), NOW);
  assert.deepEqual(ids(d.owner), []);
  assert.equal(d.notes.length, 1);
});

test('pairing walks host start → owner approve → host complete → waiting for IMD', () => {
  const held = vault({ held: true, seatOwner: V });
  let d = derive(snap({ vault: held }), NOW);
  assert.equal(d.step, 'pair');
  assert.deepEqual(ids(d.host), ['pairing-start']);
  const artifact = { digest: '0x' + 'dd'.repeat(32), message: { expiresAt: NOW + 600 } };
  d = derive(snap({ vault: held, pairing: { phase: 'offered', artifact, codeExpiresAt: (NOW + 300) * 1000 }, pairingOfferImported: false }), NOW);
  assert.deepEqual(ids(d.owner).filter((x) => x === 'approvePairing'), ['approvePairing']);
  assert.deepEqual(d.owner.find((a) => a.id === 'approvePairing').needs, ['pairing-offer']);
  d = derive(snap({ vault: vault({ held: true, seatOwner: V, approvedDigest: artifact.digest, approvedUntil: NOW + 600 }), pairing: { phase: 'offered', artifact }, pairingOfferImported: true }), NOW);
  assert.deepEqual(ids(d.host), ['pairing-complete']);
  d = derive(snap({ vault: held, pairing: { phase: 'completed', artifact, completed: true } }), NOW);
  assert.equal(d.step, 'pair');
  assert.equal(ids(d.host).length, 0);
  assert.ok(d.notes[0].includes('completed'));
  // an expired offer means starting over
  d = derive(snap({ vault: held, pairing: { phase: 'offered', artifact: { digest: artifact.digest, message: { expiresAt: NOW - 1 } } } }), NOW);
  assert.deepEqual(ids(d.host), ['pairing-start']);
});

test('registration follows enrolment, hosting follows the bind, exit follows end', () => {
  const held = vault({ held: true, seatOwner: V });
  const standing = { enrollment: { status: 'active', deviceKey: DEVICE.slice(2) }, presence: { connected: true } };
  let d = derive(snap({ vault: held, imd: { standing } }), NOW);
  assert.equal(d.step, 'register');
  assert.deepEqual(ids(d.owner).slice(0, 1), ['registerAgent']);
  d = derive(snap({ vault: held, imd: { standing }, registration: { agentId: '51760', txHash: '0x1' } }), NOW);
  assert.deepEqual(ids(d.owner).slice(0, 1), ['bind']);
  d = derive(snap({ vault: held, imd: { standing: { ...standing, agentId: '51760' } }, registration: { agentId: '51760', bound: true } }), NOW);
  assert.equal(d.step, 'active');
  assert.ok(all(d.owner).includes('end') && all(d.owner).includes('withdraw'));
  d = derive(snap({ vault: vault({ held: true, seatOwner: V, ended: true, endedAt: NOW, pending: '5' }), imd: { standing } }), NOW);
  assert.equal(d.step, 'exit');
  assert.ok(ids(d.owner).includes('withdraw') && all(d.owner).includes('settle') && all(d.host).includes('claim'));
  d = derive(snap({ vault: vault({ held: false, seatOwner: OWNER, ended: true, endedAt: NOW }) }), NOW);
  assert.equal(d.step, 'exit');
  assert.equal(d.statuses[STEPS.length - 1].status, 'done');
  assert.equal(ids(d.owner).length, 0);
});
