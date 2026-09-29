// Where the agreement is, derived from the chain and from IMD's open swarm listing. Pure and browser-safe: the owner
// and the host see the same answer. Actions are what each role can do now; one primary next action per role.

export const STEPS = [
  { key: 'create', title: 'Create the vault' },
  { key: 'deposit', title: 'Move the NFT in' },
  { key: 'pair', title: 'Approve the pairing' },
  { key: 'register', title: 'Register the agent' },
  { key: 'hosted', title: 'Hosted' },
  { key: 'exit', title: 'Exit' },
];

const zero32 = '0x' + '0'.repeat(64);
const lower = (a) => String(a || '').toLowerCase();

/// snap = { vault, imdSeat (the seat's entry in IMD's swarm listing, or null), artifact (the pasted pairing offer, or
/// null), pendingHashes (unresolved approval transactions), agentReusable (true when the registrar says the vault
/// controls a known agent) }
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
    const offerLive = !!a && a.message.expiresAt > nowSec && (!a.codeExpiresAt || a.codeExpiresAt > nowSec * 1000);
    const approvedThis = !!a && approvalLive && lower(v.approvedDigest) === lower(a.digest);
    const pendingApproval = (snap.pendingHashes || []).length > 0;
    const imdSeat = snap.imdSeat || null;
    const registered = !!(imdSeat && imdSeat.agentId) || snap.agentReusable === true;

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
    } else if (!imdSeat && !registered) {
      step = 'pair';
      if (pendingApproval) {
        owner.push({ id: 'wait', label: 'Your approval is waiting to be mined', passive: true });
      } else if (!offerLive) {
        owner.push({ id: 'pairing-offer', label: "Paste the host's pairing string", hint: 'The host runs the helper for this vault and sends you the string. It lasts five minutes.' });
        if (approvalLive) notes.push('An earlier approval is still live on the vault; it expires by itself.');
      } else if (!approvedThis) {
        owner.push({ id: 'approvePairing', label: 'Approve the pairing', hint: 'One transaction with the exact nonce, expiry and relay from the string. It must be mined before the code expires.' });
      } else {
        owner.push({ id: 'wait', label: 'Approved. The host completes the pairing now', passive: true });
      }
      host.push({ id: 'wait', label: 'Helper: waiting for the approval, then completing', passive: true });
    } else if (!registered) {
      step = 'register';
      if (a && a.intent) owner.push({ id: 'registerAgent', label: 'Register the agent', hint: "IMD's registration, sent through the vault. Once per seat, unless an agent already exists." });
      else owner.push({ id: 'pairing-offer', label: "Paste the host's pairing string again (it carries the registration)", hint: 'The registration intent travels with the pairing string.' });
      host.push({ id: 'wait', label: 'Helper: binds the agent on IMD after the registration', passive: true });
    } else {
      step = 'hosted';
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
