// Where the agreement is, derived from the chain, the owner's own records and IMD's open listing. Pure and
// browser-safe. Three things are decided separately and never conflated: the pairing (done when the owner's
// approval of the current pairing string was mined; an old IMD listing never skips it), the registration (needed
// unless the registrar says this vault controls an agent bound to exactly this seat; unknown when that could not be
// checked), and IMD's listing, which is shown as information and never as proof that the new device is paired.

export const STEPS = [
  { key: 'create', title: 'Create the vault' },
  { key: 'deposit', title: 'Move the NFT in' },
  { key: 'pair', title: 'Approve the pairing' },
  { key: 'register', title: 'Register the agent' },
  { key: 'done', title: 'Your side is done' },
  { key: 'exit', title: 'Exit' },
];

const zero32 = '0x' + '0'.repeat(64);
const lower = (a) => String(a || '').toLowerCase();

/// snap = { vault, artifact (the pasted pairing string while both its deadlines are ahead, else null), approved
/// ({ digest, code } of the owner's mined approval for this vault, or null), intent (the registration intent kept
/// from the pairing string, or null), registered ({ agentId } once the owner's registration was mined, or null),
/// pendingHashes (unresolved approval transactions), imdSeat (IMD's swarm entry or null), agentReusable
/// (true / false / null = could not be checked) }
export function derive(snap, nowSec = Math.floor(Date.now() / 1000)) {
  const v = snap.vault;
  const owner = [];
  const host = [];
  const notes = [];
  let step;

  if (!v) {
    step = 'create';
    owner.push({ id: 'create', label: 'Create the vault', hint: "Paste the host's offer string and your seat's token id. One transaction to the factory." });
    host.push({ id: 'wait', label: 'Send the owner your hosting offer string (helper: offer)', passive: true });
  } else {
    const seatInVault = lower(v.seatOwner) === lower(v.address);
    const approvalLive = v.approvedDigest && v.approvedDigest !== zero32 && v.approvedUntil > nowSec;
    const a = snap.artifact || null;
    const approvedThis = !!a && approvalLive && lower(v.approvedDigest) === lower(a.digest);
    const approvedRecord = snap.approved && (!a || lower(snap.approved.digest) === lower(a.digest)) ? snap.approved : null;
    const pairingDone = approvedThis || !!approvedRecord;
    const pendingApproval = (snap.pendingHashes || []).length > 0;
    const imdSeat = snap.imdSeat || null;
    const reuse = snap.agentReusable; // true / false / null
    const registered = !!snap.registered || reuse === true;
    const registrationUnknown = !registered && reuse === null && !!(imdSeat && imdSeat.agentId);

    if (v.ended && !seatInVault) {
      step = 'exit';
      notes.push('The NFT is back with the owner; the agreement is over. Rewards that still arrive here keep the same split.');
    } else if (v.ended) {
      step = 'exit';
      owner.push({ id: 'withdraw', label: 'Take my NFT back', hint: 'Returns the NFT to your wallet. Nothing can block it.' });
    } else if (!v.held) {
      step = 'deposit';
      if (seatInVault) owner.push({ id: 'syncHeld', label: 'Record the NFT as held', hint: 'It arrived by a plain transfer, so the vault has not recorded it yet.' });
      else if (lower(v.seatOwner) === lower(v.owner)) owner.push({ id: 'deposit', label: 'Move my NFT into the vault', hint: 'One safe transfer from your wallet; the vault records it on arrival.' });
      else notes.push(`The NFT is held by ${v.seatOwner}, not by the owner or the vault; only the owner's wallet can move it in.`);
      host.push({ id: 'wait', label: 'Waiting for the owner to move the NFT in', passive: true });
    } else if (!pairingDone) {
      step = 'pair';
      if (pendingApproval) owner.push({ id: 'wait', label: 'Your approval is waiting to be mined', passive: true });
      else if (!a) owner.push({ id: 'pairing-offer', label: "Paste the host's pairing string", hint: 'The host runs the helper for this vault and sends you the string. It lasts five minutes.' });
      else owner.push({ id: 'approvePairing', label: 'Approve the pairing', hint: 'One transaction with the exact nonce, expiry and relay from the string. It must be mined before the code expires.' });
      if (!a && approvalLive) notes.push('An earlier approval is still live on the vault; it expires by itself.');
      host.push({ id: 'wait', label: 'Helper: waiting for the approval, then completing', passive: true });
    } else if (registrationUnknown) {
      step = 'register';
      notes.push('IMD lists an agent for this seat, but the registrar could not be checked. Nothing is registered until that check works, so no registration is paid for twice.');
      owner.push({ id: 'wait', label: 'Checking the existing agent', passive: true });
    } else if (!registered) {
      step = 'register';
      if (snap.intent) owner.push({ id: 'registerAgent', label: 'Register the agent', hint: "IMD's registration for this seat, sent through the vault. Skipped when an agent already exists for it." });
      else owner.push({ id: 'pairing-offer', label: "Paste the host's pairing string again (it carries the registration)", hint: 'The registration intent travels with the pairing string.' });
      host.push({ id: 'wait', label: 'Helper: binds the agent on IMD after the registration', passive: true });
    } else {
      step = 'done';
      notes.push(imdSeat ? `IMD lists this seat${imdSeat.agentId ? ` with agent ${imdSeat.agentId}` : ''}${imdSeat.accepted !== undefined ? `, ${imdSeat.accepted} accepted jobs` : ''}. Your host confirms whether the new device is paired; this page cannot see that.` : 'IMD does not list this seat yet. Your host confirms when the worker is paired.');
    }

    if (BigInt(v.claimableOwner || 0) > 0n || BigInt(v.pending || 0) > 0n) owner.push({ id: 'claim', label: 'Claim my rewards', secondary: true });
    if (BigInt(v.claimableProvider || 0) > 0n || BigInt(v.pending || 0) > 0n) host.push({ id: 'claim', label: 'Claim my rewards', secondary: true });
    if (!v.ended && seatInVault) owner.push({ id: 'withdraw', label: 'Take my NFT back', secondary: true, hint: 'Ends the agreement and returns the NFT in one transaction.' });
  }

  const index = STEPS.findIndex((x) => x.key === step);
  const statuses = STEPS.map((x, i) => ({ key: x.key, title: x.title, status: i < index ? 'done' : i === index ? 'current' : 'todo' }));
  if (v && v.ended && lower(v.seatOwner) !== lower(v.address)) statuses[statuses.length - 1].status = 'done';
  return { step, index, statuses, owner, host, notes };
}
