// Where the agreement is, derived from what the chain and IMD say. Pure: the same snapshot gives the same answer to
// the owner and the host, so both consoles show one truth. Actions are what each role can do now.

export const STEPS = [
  { key: 'create', title: 'Create the vault' },
  { key: 'deposit', title: 'Deposit the seat NFT' },
  { key: 'pair', title: 'Pair the host\'s worker' },
  { key: 'register', title: 'Register the agent' },
  { key: 'active', title: 'Hosting' },
  { key: 'exit', title: 'Exit' },
];

const zero32 = '0x' + '0'.repeat(64);
const lower = (a) => String(a || '').toLowerCase();

export function derive(snap, nowSec = Math.floor(Date.now() / 1000)) {
  const v = snap.vault;
  const imd = snap.imd || {};
  const pairing = snap.pairing || { phase: 'none' };
  const reg = snap.registration || {};
  const owner = [];
  const host = [];
  const notes = [];
  let step;

  if (!v) {
    step = 'create';
    host.push({ id: 'hosting-offer', label: 'Publish your hosting offer', hint: 'Provider address, operator address, worker device key and your share. The owner pastes it to create the vault.' });
    owner.push({ id: 'create', label: 'Create the vault', hint: 'Paste the host\'s offer string (or type the same fields). One transaction to the factory.', needs: [] });
  } else {
    const seatInVault = lower(v.seatOwner) === lower(v.address);
    const approvalLive = v.approvedDigest && v.approvedDigest !== zero32 && v.approvedUntil > nowSec;
    const standing = imd.standing || null;
    const enrolledDevice = standing && standing.enrollment && ['active', 'enrolled'].includes(String(standing.enrollment.status || '').toLowerCase())
      ? lower(standing.enrollment.deviceKey || '') : null;
    const enrolled = !!enrolledDevice && (enrolledDevice === lower(v.deviceKey).replace(/^0x/, '') || enrolledDevice === lower(v.deviceKey));
    const agentId = reg.agentId || (standing && standing.agentId ? String(standing.agentId) : null);
    const bound = !!(reg.bound || (standing && standing.agentId));

    if (v.ended && !seatInVault) {
      step = 'exit';
      notes.push('The seat is back with the owner; the agreement is over. Rewards that still arrive here keep the same split.');
    } else if (v.ended) {
      step = 'exit';
      owner.push({ id: 'withdraw', label: 'Take the seat back', hint: 'Returns the NFT to your wallet. No call to the reward token; nothing can block it.' });
    } else if (!v.held) {
      step = 'deposit';
      if (seatInVault) {
        owner.push({ id: 'syncHeld', label: 'Record the seat as held', hint: 'The seat arrived by a plain transfer, so the vault has not recorded it yet.' });
      } else if (lower(v.seatOwner) === lower(v.owner)) {
        const approved = lower(v.seatApproved) === lower(v.address);
        if (!approved) owner.push({ id: 'approveSeat', label: 'Approve the vault for the seat', hint: 'ERC-721 approval to this vault for this token only.' });
        owner.push({ id: 'deposit', label: 'Deposit the seat', hint: 'The vault pulls the NFT from your wallet.', needs: approved ? [] : ['approveSeat'] });
      } else {
        notes.push(`The seat is held by ${v.seatOwner}, not by the owner or the vault; only the owner's wallet can deposit it.`);
      }
      host.push({ id: 'wait', label: 'Waiting for the owner to deposit', passive: true });
    } else if (!enrolled) {
      step = 'pair';
      const offerLive = pairing.phase !== 'none' && pairing.artifact && pairing.artifact.message.expiresAt > nowSec
        && (!pairing.codeExpiresAt || pairing.codeExpiresAt > Date.now());
      if (pairing.completed && !enrolled) {
        notes.push('The pairing was completed on IMD\'s side; waiting for the seat\'s standing to show the device.');
        host.push({ id: 'wait', label: 'Waiting for IMD to show the enrolment', passive: true });
      } else if (!offerLive) {
        host.push({ id: 'pairing-start', label: 'Start a pairing', hint: 'Asks IMD for a pairing code and nonce for your worker\'s device key. Codes last five minutes.' });
        owner.push({ id: 'wait', label: 'Waiting for the host\'s pairing offer', passive: true });
        if (approvalLive) owner.push({ id: 'revokePairing', label: 'Revoke the stale approval', hint: 'An earlier approval is still live; it dies when it expires, or now.' });
      } else if (!approvalLive || lower(v.approvedDigest) !== lower(pairing.artifact.digest)) {
        owner.push({ id: 'approvePairing', label: 'Approve this pairing on the vault', hint: 'One transaction: the exact nonce, expiry and relay from the host\'s offer. Must be mined before the code expires.', needs: snap.pairingOfferImported ? [] : ['pairing-offer'] });
        host.push({ id: 'wait', label: 'Waiting for the owner\'s approval to be mined', passive: true });
      } else {
        host.push({ id: 'pairing-complete', label: 'Complete the pairing', hint: 'The operator key signs the approved digest; the console checks the vault accepts it, then posts to IMD.' });
        owner.push({ id: 'wait', label: 'Approved. Waiting for the host to complete', passive: true });
      }
    } else if (!bound) {
      step = 'register';
      if (agentId && !bound) {
        owner.push({ id: 'bind', label: 'Tell IMD about the agent', hint: `Agent ${agentId} is registered on chain; IMD's bind route links it to the seat.` });
      } else {
        owner.push({ id: 'registerAgent', label: 'Register the agent through the vault', hint: 'The console fetches IMD\'s register-intent, checks it names this seat, and you send it through the vault.', needs: reg.intent ? [] : ['register-intent'] });
      }
      host.push({ id: 'wait', label: 'Waiting for the owner to register the agent', passive: true });
    } else {
      step = 'active';
    }

    // secondary actions available from the deposit onwards
    if (v.held || seatInVault) {
      if (BigInt(v.pending || 0) > 0n) { owner.push({ id: 'settle', label: 'Settle new rewards', secondary: true }); host.push({ id: 'settle', label: 'Settle new rewards', secondary: true }); }
      if (BigInt(v.claimableOwner || 0) > 0n || (BigInt(v.pending || 0) > 0n && v.providerBps < 10_000)) owner.push({ id: 'claim', label: 'Claim your rewards', secondary: true });
      if (BigInt(v.claimableProvider || 0) > 0n || (BigInt(v.pending || 0) > 0n && v.providerBps > 0)) host.push({ id: 'claim', label: 'Claim your rewards', secondary: true });
    }
    if (!v.ended && step !== 'deposit') {
      owner.push({ id: 'end', label: 'End the agreement', secondary: true, hint: 'No new pairings; the seat stays until you withdraw it.' });
      if (v.held) host.push({ id: 'end', label: 'End the agreement', secondary: true });
    }
    if (!v.ended && seatInVault && step !== 'exit') owner.push({ id: 'withdraw', label: 'Take the seat back', secondary: true, hint: 'Ends the agreement and returns the NFT in one transaction.' });
  }

  const index = STEPS.findIndex((x) => x.key === step);
  const statuses = STEPS.map((x, i) => ({ key: x.key, title: x.title, status: i < index ? 'done' : i === index ? 'current' : 'todo' }));
  if (v && v.ended && lower(v.seatOwner) !== lower(v.address)) statuses[statuses.length - 1].status = 'done';
  return { step, index, statuses, owner, host, notes };
}
