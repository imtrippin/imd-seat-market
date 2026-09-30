import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRecord, mergeRecords, pendingFor, settleReceipt, signingContext, contextUnchanged } from '../src/guards.js';

const V = '0x' + 'aa'.repeat(20);
const W = '0x' + 'bb'.repeat(20);
const H1 = '0x' + '11'.repeat(32);
const H2 = '0x' + '22'.repeat(32);
const op = (vault, action, extra = {}) => ({ vault, action, to: vault, data: '0xabcdef', at: 't0', ...extra });

test('merging records unions unresolved operations and never drops one another tab recorded', () => {
  const mine = { ...emptyRecord(), seq: 3, vault: V, pending: { [H1]: op(V, 'approvePairing') } };
  const theirs = { ...emptyRecord(), seq: 3, vault: V, pending: { [H2]: op(V, 'registerAgent') }, approved: { [V]: { digest: '0xdd', code: 'A' } } };
  const m = mergeRecords(mine, theirs);
  assert.deepEqual(Object.keys(m.pending).sort(), [H1, H2]);
  assert.deepEqual(m.approved[V], { digest: '0xdd', code: 'A' });
  assert.deepEqual(mergeRecords(mine, null), { ...mine });
  assert.deepEqual(mergeRecords(mine, 'garbage'), { ...mine });
});

test('a hash resolved on either side is never pending again, whatever a stale tab still remembers', () => {
  const stale = { ...emptyRecord(), seq: 9, vault: V, pending: { [H1]: op(V, 'approvePairing') } }; // this tab, newer seq, still remembers H1
  const stored = { ...emptyRecord(), seq: 7, vault: V, resolved: { [H1]: { status: 'success', at: 't1', vault: V, action: 'approvePairing' } }, approved: { [V]: { digest: '0xdd', code: 'A', txHash: H1 } } };
  const m = mergeRecords(stale, stored);
  assert.deepEqual(m.pending, {}, 'the stale pending entry does not come back');
  assert.equal(m.resolved[H1].status, 'success');
  assert.equal(m.approved[V].txHash, H1, 'the mined approval survives the merge');
  const again = mergeRecords(m, stale);
  assert.deepEqual(again.pending, {});
  assert.equal(mergeRecords({ ...emptyRecord(), pendingApprovals: { [V]: [H2] } }, stored).pendingApprovals, undefined, 'the older shape is dropped');
});

test('a tab that saved nothing takes what storage holds; a newer save wins the selection; a tie keeps this tab', () => {
  const stored = { ...emptyRecord(), seq: 5, vault: V, artifactText: 'seatpair1:x', log: [{ at: 't', text: 'stored' }] };
  const fresh = mergeRecords(emptyRecord(), stored);
  assert.equal(fresh.vault, V);
  assert.equal(fresh.artifactText, 'seatpair1:x');
  assert.equal(fresh.seq, 5);
  const cleared = mergeRecords({ ...emptyRecord(), seq: 5, vault: V, artifactText: null }, stored);
  assert.equal(cleared.artifactText, null, 'this tab cleared the string at the same sequence: its view stands');
  const newer = mergeRecords({ ...emptyRecord(), seq: 4, vault: V, artifactText: 'old' }, { ...stored, seq: 6, artifactText: null });
  assert.equal(newer.artifactText, null, 'another tab saved later: its state wins');
  assert.equal(newer.seq, 6);
});

test('pending operations are listed per vault', () => {
  const pending = { [H1]: op(V, 'approvePairing'), [H2]: op(W, 'approvePairing') };
  assert.deepEqual(pendingFor(pending, V).map(([h]) => h), [H1]);
  assert.deepEqual(pendingFor(pending, V.toUpperCase()).map(([h]) => h), [H1]);
  assert.equal(pendingFor(pending).length, 2);
  assert.deepEqual(pendingFor(undefined, V), []);
});

test('a mined approval is settled against the recorded operation: success reconstructs the approval, a revert frees a retry', () => {
  const rec = { ...emptyRecord(), seq: 2, vault: V, pending: { [H1]: op(V, 'approvePairing', { digest: '0xdd', code: 'C0DE' }) } };
  const receipt = { transactionHash: H1, to: V, status: 'success', blockNumber: 102n };
  const sent = { to: V, input: '0xabcdef' };
  const ok = settleReceipt(rec, H1, receipt, sent, { at: 't1' });
  assert.equal(ok.status, 'success');
  assert.deepEqual(ok.record.pending, {});
  assert.deepEqual(ok.record.resolved[H1], { status: 'success', block: 102, at: 't1', vault: V, action: 'approvePairing' });
  assert.deepEqual(ok.record.approved[V], { digest: '0xdd', code: 'C0DE', at: 't1', txHash: H1 });
  assert.deepEqual(rec.pending[H1], op(V, 'approvePairing', { digest: '0xdd', code: 'C0DE' }), 'the input record is not mutated');
  const reverted = settleReceipt(rec, H1, { ...receipt, status: 'reverted' }, sent, { at: 't1' });
  assert.equal(reverted.status, 'reverted');
  assert.deepEqual(reverted.record.pending, {});
  assert.equal(reverted.record.approved[V], undefined, 'a reverted approval is not an approval');
  assert.equal(settleReceipt(rec, H2, { ...receipt, transactionHash: H2 }, null).status, null, 'an unknown hash settles nothing');
  assert.equal(settleReceipt(rec, H1.toUpperCase(), receipt, null).status, 'success', 'hash case does not matter');
});

test('a receipt or transaction that does not match what this page sent resolves the hash without believing it', () => {
  const rec = { ...emptyRecord(), pending: { [H1]: op(V, 'approvePairing', { digest: '0xdd', code: 'C0DE' }) } };
  const receipt = { transactionHash: H1, to: V, status: 'success', blockNumber: 5n };
  assert.equal(settleReceipt(rec, H1, receipt, { to: W, input: '0xabcdef' }).status, 'mismatch', 'another target');
  assert.equal(settleReceipt(rec, H1, receipt, { to: V, input: '0xabcdee' }).status, 'mismatch', 'other calldata');
  assert.equal(settleReceipt(rec, H1, { ...receipt, to: W }, null).status, 'mismatch', 'the receipt names another target');
  assert.equal(settleReceipt(rec, H1, { ...receipt, transactionHash: H2 }, null).status, 'mismatch', 'another hash');
  const m = settleReceipt(rec, H1, receipt, { to: W, input: '0xabcdef' });
  assert.deepEqual(m.record.pending, {});
  assert.equal(m.record.approved[V], undefined);
  assert.equal(m.record.resolved[H1].status, 'mismatch');
});

test('a mined registration records the agent id the receipt carried, for the operation\'s own vault', () => {
  const rec = { ...emptyRecord(), vault: W, pending: { [H2]: op(V, 'registerAgent') } };
  const r = settleReceipt(rec, H2, { transactionHash: H2, to: V, status: 'success', blockNumber: 9n }, { to: V, input: '0xabcdef' }, { agentId: '51' });
  assert.deepEqual(r.record.registered[V], { agentId: '51', txHash: H2 });
  assert.equal(r.record.registered[W], undefined, 'the current selection is not what gets the record');
});

test('the wallet request is refused when the reviewed context changed', () => {
  const reviewed = signingContext({ chainId: 1, account: '0xAbC', vault: V, action: 'deposit', to: V, data: '0x01' });
  assert.equal(contextUnchanged(reviewed, signingContext({ chainId: 1, account: '0xabc', vault: V, action: 'deposit', to: V, data: '0x01' })), true);
  assert.equal(contextUnchanged(reviewed, signingContext({ chainId: 11155111, account: '0xabc', vault: V, action: 'deposit', to: V, data: '0x01' })), false, 'chain changed');
  assert.equal(contextUnchanged(reviewed, signingContext({ chainId: 1, account: '0xdef', vault: V, action: 'deposit', to: V, data: '0x01' })), false, 'account changed');
  assert.equal(contextUnchanged(reviewed, signingContext({ chainId: 1, account: '0xabc', vault: V, action: 'deposit', to: V, data: '0x02' })), false, 'calldata changed');
  assert.equal(contextUnchanged(reviewed, null), false);
});
