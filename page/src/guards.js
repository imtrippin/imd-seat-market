// Pure rules for the agreement page, kept apart from the DOM so they run under Node: the browser record (one per
// chain, merged from storage before every save), the settlement of a mined transaction against the operation this
// browser recorded when it sent it, and the signing context that must not change between the review and the
// wallet request. Tab coordination itself is the Web Locks API in app.js; nothing here is time-based.

const lower = (v) => String(v || '').toLowerCase();

export function emptyRecord() {
  return { seq: 0, vault: null, artifactText: null, approved: {}, intents: {}, registered: {}, pending: {}, resolved: {}, log: [] };
}

/// Merge what another tab may have written with what this tab knows. Every save carries a sequence number: the
/// newer record supplies the selection, the pasted string and the history; mined approvals and registrations are
/// kept from both sides (the newer one winning a conflict); unresolved operations are unioned; and a hash that
/// either side has resolved is never pending again, whatever a stale tab still remembers. A tab that has saved
/// nothing yet (seq 0) therefore takes what storage holds.
export function mergeRecords(mine, theirs) {
  const a = mine && typeof mine === 'object' ? mine : emptyRecord();
  const b = theirs && typeof theirs === 'object' ? theirs : emptyRecord();
  const aSeq = Number(a.seq) || 0;
  const bSeq = Number(b.seq) || 0;
  const [older, newer] = bSeq > aSeq ? [a, b] : [b, a];
  const out = { ...emptyRecord(), ...older, ...newer };
  out.seq = Math.max(aSeq, bSeq);
  out.approved = { ...(older.approved || {}), ...(newer.approved || {}) };
  out.intents = { ...(older.intents || {}), ...(newer.intents || {}) };
  out.registered = { ...(older.registered || {}), ...(newer.registered || {}) };
  out.resolved = {};
  for (const src of [older, newer]) for (const [h, r] of Object.entries(src.resolved || {})) out.resolved[lower(h)] = r;
  out.pending = {};
  for (const src of [older, newer]) for (const [h, op] of Object.entries(src.pending || {})) if (!out.resolved[lower(h)]) out.pending[lower(h)] = op;
  delete out.pendingApprovals; // an earlier shape of the record; never merged back
  return out;
}

/// The unresolved operations, as [hash, op] pairs, for one vault or for all.
export function pendingFor(pending, vault) {
  const v = vault ? lower(vault) : null;
  return Object.entries(pending || {}).filter(([, op]) => !v || lower(op && op.vault) === v);
}

/// One mined transaction becomes a record here, and only here. The receipt and, when available, the mined
/// transaction are checked against the operation recorded at send time (same hash, same target, same calldata);
/// a mismatch resolves the hash without believing it. Success reconstructs what the operation meant: the owner's
/// approval of exactly the recorded digest, or the registration with the agent id read from the receipt's logs.
/// The vault is the operation's own, never a later selection.
export function settleReceipt(record, hash, receipt, sent, extra = {}) {
  const h = lower(hash);
  const pending = record.pending || {};
  const op = pending[h] || pending[hash];
  if (!op) return { record, status: null, op: null };
  const at = extra.at || new Date().toISOString();
  let status;
  if (lower(receipt.transactionHash) !== h) status = 'mismatch';
  else if (receipt.to && lower(receipt.to) !== lower(op.to)) status = 'mismatch';
  else if (sent && (lower(sent.to) !== lower(op.to) || lower(sent.input) !== lower(op.data))) status = 'mismatch';
  else status = receipt.status === 'success' ? 'success' : 'reverted';
  const next = { ...record, pending: { ...pending }, resolved: { ...(record.resolved || {}) }, approved: { ...(record.approved || {}) }, registered: { ...(record.registered || {}) } };
  delete next.pending[h];
  delete next.pending[hash];
  next.resolved[h] = { status, block: receipt.blockNumber !== undefined && receipt.blockNumber !== null ? Number(receipt.blockNumber) : null, at, vault: lower(op.vault), action: op.action };
  if (status === 'success' && op.action === 'approvePairing') next.approved[lower(op.vault)] = { digest: op.digest, code: op.code, at, txHash: h };
  if (status === 'success' && op.action === 'registerAgent') next.registered[lower(op.vault)] = { agentId: extra.agentId === undefined ? null : extra.agentId, txHash: h };
  return { record: next, status, op };
}

/// The context reviewed in the confirmation dialog; the wallet request must be made under the same one.
export function signingContext({ chainId, account, vault, action, to, data }) {
  return { chainId: Number(chainId), account: lower(account), vault: lower(vault), action, to: lower(to), data: String(data || '') };
}

export function contextUnchanged(reviewed, current) {
  return !!reviewed && !!current && reviewed.chainId === current.chainId && reviewed.account === current.account && reviewed.vault === current.vault && reviewed.action === current.action && reviewed.to === current.to && reviewed.data === current.data;
}
