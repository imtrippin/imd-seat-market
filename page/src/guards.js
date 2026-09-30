// Pure guards for the agreement page, kept apart from the DOM so they can be unit-tested with Node: the browser
// record (one per chain, merged from storage before every protected action), the signing context that must not
// change between the review and the wallet request, and a small lock so two tabs cannot send the same approval.

export const LOCK_TTL_MS = 90_000;

export function emptyRecord() {
  return { seq: 0, vault: null, artifactText: null, approved: {}, intents: {}, registered: {}, pendingApprovals: {}, log: [] };
}

/// Merge what another tab may have written with what this tab knows. Every save carries a sequence number: the
/// newer record supplies the selection, the pasted string and the history; records of mined approvals and
/// registrations are kept from both sides (the newer one winning a conflict); unresolved approvals are unioned,
/// never dropped. A tab that has saved nothing yet (seq 0) therefore takes what storage holds.
export function mergeRecords(mine, theirs) {
  if (!theirs || typeof theirs !== 'object') return mine;
  const mineSeq = Number(mine.seq) || 0;
  const theirsSeq = Number(theirs.seq) || 0;
  const [older, newer] = theirsSeq > mineSeq ? [mine, theirs] : [theirs, mine];
  const out = { ...emptyRecord(), ...older, ...newer };
  out.seq = Math.max(mineSeq, theirsSeq);
  out.approved = { ...(older.approved || {}), ...(newer.approved || {}) };
  out.intents = { ...(older.intents || {}), ...(newer.intents || {}) };
  out.registered = { ...(older.registered || {}), ...(newer.registered || {}) };
  out.pendingApprovals = { ...(older.pendingApprovals || {}) };
  for (const [vault, hashes] of Object.entries(newer.pendingApprovals || {})) {
    out.pendingApprovals[vault] = [...new Set([...(out.pendingApprovals[vault] || []), ...hashes])];
  }
  return out;
}

/// The context reviewed in the confirmation dialog; the wallet request must be made under the same one.
export function signingContext({ chainId, account, vault, action, to, data }) {
  return { chainId: Number(chainId), account: String(account || '').toLowerCase(), vault: String(vault || '').toLowerCase(), action, to: String(to || '').toLowerCase(), data: String(data || '') };
}

export function contextUnchanged(reviewed, current) {
  return !!reviewed && !!current && reviewed.chainId === current.chainId && reviewed.account === current.account && reviewed.vault === current.vault && reviewed.action === current.action && reviewed.to === current.to && reviewed.data === current.data;
}

/// A protected send (an approval) may not start while another tab holds a fresh lock for the same vault.
export function lockIsFree(lockValue, nowMs = Date.now(), ttl = LOCK_TTL_MS) {
  const t = Number(lockValue);
  return !Number.isFinite(t) || t <= 0 || nowMs - t > ttl;
}
