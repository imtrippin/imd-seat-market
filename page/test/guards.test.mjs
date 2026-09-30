import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRecord, mergeRecords, signingContext, contextUnchanged, lockIsFree, LOCK_TTL_MS } from '../src/guards.js';

const V = '0x' + 'aa'.repeat(20);

test('merging records never drops an unresolved approval another tab recorded', () => {
  const mine = { ...emptyRecord(), seq: 3, vault: V, pendingApprovals: { [V]: ['0x01'] } };
  const theirs = { ...emptyRecord(), seq: 3, vault: V, pendingApprovals: { [V]: ['0x02'] }, approved: { [V]: { digest: '0xdd', code: 'A' } } };
  const m = mergeRecords(mine, theirs);
  assert.deepEqual(m.pendingApprovals[V].sort(), ['0x01', '0x02']);
  assert.deepEqual(m.approved[V], { digest: '0xdd', code: 'A' });
  assert.equal(mergeRecords(mine, null), mine);
  assert.deepEqual(mergeRecords(mine, 'garbage'), mine);
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

test('the wallet request is refused when the reviewed context changed', () => {
  const reviewed = signingContext({ chainId: 1, account: '0xAbC', vault: V, action: 'deposit', to: V, data: '0x01' });
  assert.equal(contextUnchanged(reviewed, signingContext({ chainId: 1, account: '0xabc', vault: V, action: 'deposit', to: V, data: '0x01' })), true);
  assert.equal(contextUnchanged(reviewed, signingContext({ chainId: 11155111, account: '0xabc', vault: V, action: 'deposit', to: V, data: '0x01' })), false, 'chain changed');
  assert.equal(contextUnchanged(reviewed, signingContext({ chainId: 1, account: '0xdef', vault: V, action: 'deposit', to: V, data: '0x01' })), false, 'account changed');
  assert.equal(contextUnchanged(reviewed, signingContext({ chainId: 1, account: '0xabc', vault: V, action: 'deposit', to: V, data: '0x02' })), false, 'calldata changed');
  assert.equal(contextUnchanged(reviewed, null), false);
});

test('the per-vault lock blocks a second approval for its lifetime only', () => {
  const now = 1_800_000_000_000;
  assert.equal(lockIsFree(null, now), true);
  assert.equal(lockIsFree(String(now - 1000), now), false);
  assert.equal(lockIsFree(String(now - LOCK_TTL_MS - 1), now), true);
  assert.equal(lockIsFree('not a number', now), true);
});
