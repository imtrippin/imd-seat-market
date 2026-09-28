export const HOSTS = [{
  id: 'northstar',
  securityDeposit: 1000,
  dailyMinimum: 200,
  machine: {
    cpu: 4,
    ramGb: 8,
    diskGb: 80
  },
  skills: ['Smart contracts', 'Websites', 'Image work'],
  llmOptions: ['Codex · host-selected model', 'Codex · owner-arranged access'],
  name: 'Northstar',
  initials: 'NS',
  region: 'US East',
  runtime: 'Codex',
  tools: ['Browser', 'Image', 'Foundry'],
  ownerBps: 7000,
  slots: 3,
  ai: 'Host supplied',
  capacity: 'Shared pool · disclosed limits',
  color: 'blue',
  description: 'Managed workers for contract builds, websites, and image-assisted work.',
  service: 'Updates between jobs, daily monitoring, and an agreed handoff when you leave.'
}, {
  id: 'relay',
  securityDeposit: 600,
  dailyMinimum: 100,
  machine: {
    cpu: 8,
    ramGb: 16,
    diskGb: 160
  },
  skills: ['Smart contracts', 'Research', 'Code review'],
  llmOptions: ['Claude Code · host-selected model', 'Claude Code · owner-arranged access'],
  name: 'Relay Collective',
  initials: 'RC',
  region: 'EU West',
  runtime: 'Claude',
  tools: ['Browser', 'Foundry'],
  ownerBps: 7500,
  slots: 2,
  ai: 'Host supplied',
  capacity: 'Shared pool · disclosed limits',
  color: 'violet',
  description: 'A small operator focused on contract and research workloads.',
  service: 'Worker maintenance and incident support. AI capacity is shared; job availability is not guaranteed.'
}, {
  id: 'harbor',
  securityDeposit: 0,
  dailyMinimum: 0,
  machine: {
    cpu: 2,
    ramGb: 4,
    diskGb: 60
  },
  skills: ['Websites', 'Browser automation'],
  llmOptions: ['Codex · owner-arranged access'],
  name: 'Harbor Works',
  initials: 'HW',
  region: 'US West',
  runtime: 'Codex',
  tools: ['Browser', 'Foundry'],
  ownerBps: 8500,
  slots: 1,
  ai: 'Owner arranged',
  capacity: 'Authentication arrangement required',
  color: 'orange',
  description: 'Bring an approved AI arrangement; the host handles the machine.',
  service: 'Machine and maintenance only. Never send passwords or authentication files through this prototype.'
}];
export const money = n => (n / 100).toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
export const percent = bps => `${bps / 100}%`;

// Deterministic local demonstration; no chain, credentials, or payments.
export const HOUR = 3600000;
export const PERIOD = 24 * HOUR;
// Illustrative timing from the developer's chat report, not a network SLA.
export const TRANSFER_DELAY = HOUR / 2;
export const GRACE_HOURS = 72;
export const MIN_REVIEW_HOURS = 24;
export const PAYER = 'IMD Disperse (demo)';
export const START_TIME = Date.parse('2026-09-28T12:00:00Z');
export function initialState() {
  return {
    schema: 4,
    seq: 0,
    now: START_TIME,
    nextId: 1,
    hosts: structuredClone(HOSTS),
    agreements: []
  };
}
const copy = value => structuredClone(value);
const requireThat = (condition, message) => {
  if (!condition) throw Error(message);
};
const participant = role => requireThat(['owner', 'host'].includes(role), 'Choose the owner or host preview.');
function validSplit(value) {
  requireThat(Number.isInteger(value) && value >= 100 && value <= 9900, 'Owner share must be between 1% and 99%.');
}
function event(state, a, text) {
  state.seq++;
  state.now++;
  const ev = {
    seq: state.seq,
    at: state.now,
    text
  };
  a.history.push(ev);
  return ev;
}
export function currentVersion(a) {
  return [...a.versions].reverse().find(v => v.status === 'accepted') || null;
}
export function pendingVersion(a) {
  return a.versions.find(v => v.status === 'proposed') || null;
}
export function deviceConnected(a) {
  return ['paired', 'transfer-pending'].includes(a.pairing);
}
export function available(a, role) {
  return role === 'host' ? sum(a.payments) + sum(a.reserveAllocations) - sum(a.withdrawals) : 0;
}
const sum = rows => rows.reduce((n, r) => n + r.amount, 0);
export function reserveBalance(a) {
  return sum(a.deposits) - sum(a.reserveAllocations) - sum(a.refunds);
}
export function serviceMinimum(a, now) {
  if (a.pairedAt === null) return 0;
  const elapsed = Math.max(0, Math.min(now, a.unpairedAt ?? now, a.ended?.at ?? now) - a.pairedAt);
  return Number(BigInt(elapsed) * BigInt(a.host.dailyMinimum) / BigInt(24 * HOUR));
}
export function hostEntitlement(a, now) {
  return billingPeriods(a, now).reduce((n, p) => n + p.entitlement, 0);
}
export function unfundedHostShare(a, now) {
  return billingPeriods(a, now).reduce((n, p) => n + p.owed, 0);
}
export function collectibleDue(a, now) {
  return billingPeriods(a, now).reduce((n, p) => n + p.collectible, 0);
}
export function unsecuredExposure(a, now) {
  return Math.max(0, unfundedHostShare(a, now) - reserveBalance(a));
}
export function pauseRecommended(a, now) {
  const exposure = unsecuredExposure(a, now);
  return a.host.dailyMinimum > 0 ? exposure >= a.host.dailyMinimum : exposure > 0;
}
export function arrivalKey(r) {
  return JSON.stringify({
    id: r.id,
    at: r.at,
    amount: r.amount,
    payer: r.payer,
    wallet: r.wallet,
    version: r.version,
    owner: r.owner,
    host: r.host
  });
}
// Each fixed period keeps its own compensation and payment credit. Paying a large
// unacknowledged share in one period cannot prepay another period's minimum.
export function billingPeriods(a, now) {
  if (a.pairedAt === null || now < a.pairedAt) return [];
  const periods = new Map();
  const get = i => {
    if (!periods.has(i)) periods.set(i, {
      index: i,
      startAt: a.pairedAt + i * PERIOD,
      minimum: 0,
      share: 0,
      acknowledged: 0,
      funded: 0
    });
    return periods.get(i);
  };
  const elapsed = Math.max(0, Math.min(now, a.unpairedAt ?? now, a.ended?.at ?? now) - a.pairedAt);
  for (let i = 0; i < Math.ceil(elapsed / PERIOD); i++) get(i).minimum = Number(BigInt(Math.min(PERIOD, elapsed - i * PERIOD)) * BigInt(a.host.dailyMinimum) / BigInt(PERIOD));
  for (const r of a.arrivals) if (r.version !== null && r.at <= now) {
    const p = get(Math.floor((r.at - a.pairedAt) / PERIOD));
    p.share += r.host;
    if (a.attestations.some(t => t.arrivalId === r.id && t.at <= now)) p.acknowledged += r.host;
  }
  for (const r of [...a.payments, ...a.reserveAllocations]) if (r.at <= now) for (const allocation of r.allocations) get(allocation.period).funded += allocation.amount;
  return [...periods.values()].sort((x, y) => x.index - y.index).map(p => ({
    ...p,
    entitlement: Math.max(p.minimum, p.share),
    owed: Math.max(0, Math.max(p.minimum, p.share) - p.funded),
    collectible: Math.max(0, Math.max(p.minimum, p.acknowledged) - p.funded)
  }));
}
function allocate(a, now, amount, field) {
  let remaining = amount;
  const allocations = [];
  for (const p of billingPeriods(a, now)) {
    const part = Math.min(remaining, p[field]);
    if (part > 0) allocations.push({
      period: p.index,
      amount: part
    });
    remaining -= part;
  }
  requireThat(remaining === 0, 'Payment exceeds the amount owed.');
  return allocations;
}
export function pairedHours(a, now) {
  return a.pairedAt === null ? 0 : Math.max(0, (Math.min(now, a.unpairedAt ?? now, a.ended?.at ?? now) - a.pairedAt) / HOUR);
}
export function reviewEligible(a, now) {
  return Boolean(currentVersion(a) && a.pairedAt !== null && (pairedHours(a, now) >= MIN_REVIEW_HOURS || a.arrivals.some(r => r.version !== null && r.at >= a.pairedAt && r.at < Math.min(a.unpairedAt ?? Infinity, a.ended?.at ?? Infinity))));
}
export function graceEnd(a) {
  return a.ended && currentVersion(a) ? a.ended.at + GRACE_HOURS * HOUR : null;
}
export function coverageAt(a, at, payer = PAYER, wallet = a.wallet) {
  if (payer !== PAYER) return {
    version: null,
    phase: 'excluded',
    reason: 'Different payer'
  };
  if (wallet !== a.wallet) return {
    version: null,
    phase: 'excluded',
    reason: 'Different receiving wallet'
  };
  if (a.pairedAt === null || at < a.pairedAt) return {
    version: null,
    phase: 'excluded',
    reason: 'Service not activated at arrival'
  };
  const active = a.versions.find(v => v.status === 'accepted' && at >= v.startAt && (v.endAt === null || at < v.endAt));
  if (active) return {
    version: active.number,
    phase: 'active',
    reason: 'Terms active at arrival'
  };
  if (a.ended && at >= a.ended.at && graceEnd(a) !== null && at < graceEnd(a)) return {
    version: currentVersion(a).number,
    phase: 'grace',
    reason: 'Arrival inside the agreed exit window'
  };
  return {
    version: null,
    phase: 'excluded',
    reason: a.ended && graceEnd(a) !== null && at >= a.ended.at ? 'Exit window closed' : 'No accepted terms at arrival'
  };
}
function split(amount, bps) {
  const owner = Number(BigInt(amount) * BigInt(bps) / 10000n);
  return {
    owner,
    host: amount - owner
  };
}
function snapshotTerms(a, ownerBps) {
  return {
    seat: a.nft,
    owner: a.owner,
    provider: a.hostRecipient,
    hostId: a.host.id,
    runtime: a.host.runtime,
    service: a.host.service,
    ai: a.host.ai,
    machine: copy(a.host.machine),
    skills: copy(a.host.skills),
    llm: a.llm,
    wallet: a.wallet,
    dedicatedWallet: true,
    source: PAYER,
    asset: a.asset,
    ownerBps,
    rulesVersion: 1,
    attribution: 'arrival-time',
    graceHours: GRACE_HOURS,
    securityDeposit: a.host.securityDeposit,
    dailyMinimum: a.host.dailyMinimum,
    billing: 'max-per-period',
    periodMs: PERIOD,
    periodAnchor: 'service-activation',
    minimumBasis: 'elapsed-agreement-time',
    collateralAuthority: 'elapsed-minimum-or-owner-attested-share',
    attestationDeadline: 'exit-window-exclusive',
    funding: 'provider-only-payment',
    rounding: 'floor-minor-units-remainder-to-provider',
    exit: 'either-party-72h-arrival-window'
  };
}
export function termsKey(version) {
  return JSON.stringify(version.terms);
}
function checkProfile(machine, skills, llmOptions) {
  requireThat(machine && Number.isInteger(machine.cpu) && machine.cpu >= 1 && machine.cpu <= 256 && Number.isInteger(machine.ramGb) && machine.ramGb >= 1 && machine.ramGb <= 2048 && Number.isInteger(machine.diskGb) && machine.diskGb >= 1 && machine.diskGb <= 16384, 'Use valid machine specs: 1–256 vCPU, 1–2048 GB RAM, 1–16384 GB disk.');
  for (const values of [skills, llmOptions]) requireThat(Array.isArray(values) && values.length >= 1 && values.length <= 8 && values.every(v => typeof v === 'string' && v.trim().length >= 2 && v.length <= 80), 'List 1–8 skills and LLM options, each 2–80 characters.');
}
function version(a, number, ownerBps) {
  return {
    number,
    ownerBps,
    terms: snapshotTerms(a, ownerBps),
    approvals: {
      owner: false,
      host: false
    },
    status: 'proposed',
    startAt: null,
    endAt: null
  };
}
export function createHost(state, input) {
  requireThat(typeof input.name === 'string' && input.name.trim().length >= 3 && input.name.length <= 40, 'Use a host name between 3 and 40 characters.');
  requireThat(['US East', 'US West', 'EU West', 'Asia Pacific'].includes(input.region), 'Choose a listed region.');
  requireThat(['Codex', 'Claude'].includes(input.runtime), 'Choose a supported example runtime.');
  requireThat(['Host supplied', 'Owner arranged'].includes(input.ai), 'Choose an AI arrangement.');
  requireThat(Number.isInteger(input.slots) && input.slots >= 1 && input.slots <= 20, 'Use between 1 and 20 example slots.');
  validSplit(input.ownerBps);
  const securityDeposit = input.securityDeposit ?? 1000,
    dailyMinimum = input.dailyMinimum ?? 200;
  requireThat([securityDeposit, dailyMinimum].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 100000000) && securityDeposit >= dailyMinimum, 'Use non-negative demo deposit and daily minimum amounts; deposit must cover at least one day.');
  const machine = input.machine ?? {
      cpu: 4,
      ramGb: 8,
      diskGb: 80
    },
    skills = input.skills ?? ['Websites'],
    llmOptions = input.llmOptions ?? [input.runtime + ' · host-selected model'];
  checkProfile(machine, skills, llmOptions);
  const description = input.description ?? 'A locally created example offer. Identity and capacity have not been verified.';
  const service = input.service ?? 'Example maintenance and hosting arrangement. Both parties must confirm AI access and support terms before any real use.';
  requireThat([description, service].every(v => typeof v === 'string' && v.trim().length >= 10 && v.length <= 500), 'Use 10–500 characters for the introduction and service terms.');
  const next = copy(state),
    name = input.name.trim();
  next.hosts.push({
    id: `local-${next.nextId++}`,
    name,
    initials: name.split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase(),
    region: input.region,
    runtime: input.runtime,
    ai: input.ai,
    slots: input.slots,
    ownerBps: input.ownerBps,
    securityDeposit,
    dailyMinimum,
    machine: copy(machine),
    skills: copy(skills),
    llmOptions: copy(llmOptions),
    tools: ['Browser'],
    capacity: 'Illustrative capacity',
    color: 'blue',
    description: description.trim(),
    service: service.trim()
  });
  return next;
}
export function createAgreement(state, {
  hostId,
  nft,
  ownerBps,
  wallet,
  dedicatedWallet,
  llm
}) {
  const host = state.hosts.find(h => h.id === hostId);
  requireThat(host, 'Choose an example host.');
  llm ??= host.llmOptions[0];
  requireThat(host.llmOptions.includes(llm), 'Choose an advertised LLM option.');
  requireThat(typeof nft === 'string' && /^\d{1,6}$/.test(nft), 'Use a demo NFT number with 1–6 digits.');
  nft = String(Number(nft));
  validSplit(ownerBps);
  requireThat(dedicatedWallet === true, 'Confirm a dedicated wallet for this hosted NFT.');
  requireThat(typeof wallet === 'string' && /^[a-zA-Z0-9-]{3,40}$/.test(wallet), 'Use a fictional wallet label with 3–40 letters, numbers or hyphens.');
  wallet = wallet.toLowerCase();
  requireThat(!state.agreements.some(a => a.nft === nft && (!a.ended || deviceConnected(a))), 'This demo NFT already has an open agreement or a worker awaiting disconnection.');
  requireThat(!state.agreements.some(a => a.wallet === wallet && (!a.ended || deviceConnected(a) || state.now < (graceEnd(a) ?? 0))), 'This receiving wallet is reserved through its agreement and exit window. Use a separate dedicated wallet.');
  requireThat(state.agreements.filter(a => a.host.id === hostId && (!a.ended || deviceConnected(a))).length < host.slots, 'This example host has no demo slots left.');
  const next = copy(state),
    id = `SM-${String(next.nextId++).padStart(3, '0')}`;
  const a = {
    id,
    nft,
    llm,
    host: copy(host),
    owner: 'Demo owner',
    wallet,
    hostRecipient: `${host.name} · demo recipient`,
    asset: 'DEMO credits',
    ended: null,
    routing: 'owner-wallet',
    pairing: 'unpaired',
    pairedAt: null,
    unpairedAt: null,
    transferRequestedAt: null,
    versions: [],
    arrivals: [],
    attestations: [],
    payments: [],
    withdrawals: [],
    deposits: [],
    reserveAllocations: [],
    refunds: [],
    history: []
  };
  a.versions.push(version(a, 1, ownerBps));
  next.agreements.push(a);
  event(next, a, 'Proposal created. Owner receives rewards and pays only provider compensation.');
  return {
    state: next,
    id
  };
}
function endAgreement(state, a, by, reason) {
  if (a.ended) return;
  const current = currentVersion(a),
    pending = pendingVersion(a);
  const ev = event(state, a, current ? `${by} ended participation (${reason}). The proposed 72-hour arrival window begins; funded claims persist.` : `${by} closed the unaccepted proposal. No arrival window or service charge starts.`);
  a.ended = {
    seq: ev.seq,
    at: ev.at,
    by,
    reason
  };
  if (current) current.endAt = ev.at;
  if (pending) pending.status = 'cancelled';
}
export function transition(state, id, action, role, payload = {}) {
  const next = copy(state),
    a = next.agreements.find(a => a.id === id);
  requireThat(a, 'Agreement not found.');
  const current = currentVersion(a),
    pending = pendingVersion(a);
  switch (action) {
    case 'approve':
      {
        participant(role);
        requireThat(!a.ended && pending, 'There is no open version to approve.');
        requireThat(payload.version === pending.number && payload.termsKey === termsKey(pending), 'Terms changed; review the exact current version.');
        requireThat(!pending.approvals[role], 'This side already approved these terms.');
        pending.approvals[role] = true;
        event(next, a, `${role} approved version ${pending.number} (simulated).`);
        if (pending.approvals.owner && pending.approvals.host) {
          const ev = event(next, a, `Version ${pending.number} accepted. Its split applies to subsequent covered arrivals.`);
          if (current) current.endAt = ev.at;
          pending.status = 'accepted';
          pending.startAt = ev.at;
        }
        break;
      }
    case 'amend':
      {
        participant(role);
        requireThat(!a.ended && (current || pending), 'There is no open agreement to amend.');
        validSplit(payload.ownerBps);
        requireThat(payload.ownerBps !== (pending || current).ownerBps, 'Propose a different split.');
        requireThat(!current || payload.ownerBps !== current.ownerBps, 'These are current terms. Discard the pending proposal instead.');
        if (pending) pending.status = 'superseded';
        a.versions.push(version(a, a.versions.length + 1, payload.ownerBps));
        event(next, a, `${role} proposed version ${a.versions.length}. Both parties must approve; prior arrivals retain their assigned split.`);
        break;
      }
    case 'discard':
      {
        participant(role);
        requireThat(!a.ended && current && pending, 'There is no pending amendment to discard.');
        pending.status = 'cancelled';
        event(next, a, `${role} discarded the amendment. Current terms continue.`);
        break;
      }
    case 'pair':
      {
        requireThat(role === 'demo', 'This is a simulation control.');
        requireThat(current && !a.ended && a.pairing === 'unpaired', 'Accept an open agreement before simulating pairing.');
        requireThat(reserveBalance(a) >= a.host.securityDeposit, 'Fund the agreed security deposit before pairing.');
        a.pairing = 'paired';
        a.pairedAt = event(next, a, 'Mock worker paired. No live device enrolled.').at;
        break;
      }
    case 'advance':
      {
        requireThat(role === 'demo', 'This is a simulation control.');
        requireThat(Number.isSafeInteger(payload.ms) && payload.ms > 0 && payload.ms <= 30 * 24 * HOUR, 'Advance by a positive interval of at most 30 days.');
        next.now += payload.ms - 1;
        const ev = event(next, a, `Demo clock advanced by ${payload.ms / HOUR} hours for all agreements.`);
        ev.kind = 'clock';
        ev.ms = payload.ms;
        for (const other of next.agreements) if (other.id !== a.id) other.history.push(copy(ev));
        break;
      }
    case 'arrive':
      {
        requireThat(role === 'demo', 'This is a simulation control.');
        requireThat(Number.isSafeInteger(payload.amount) && payload.amount > 0 && payload.amount <= 100000000, 'Use a positive, bounded whole number of demo minor units.');
        requireThat(typeof payload.arrivalId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(payload.arrivalId), 'Give the example arrival a valid unique ID.');
        requireThat(!next.agreements.some(x => x.arrivals.some(r => r.id === payload.arrivalId)), 'This arrival has already been recorded.');
        requireThat(typeof payload.payer === 'string' && typeof payload.wallet === 'string', 'Specify the payer and receiving wallet.');
        requireThat(!Object.hasOwn(payload, 'at'), 'Arrivals use the demo clock; backdating is not supported.');
        const at = next.now + 1,
          coverage = coverageAt(a, at, payload.payer, payload.wallet),
          v = a.versions.find(v => v.number === coverage.version);
        const shares = v ? split(payload.amount, v.ownerBps) : {
          owner: 0,
          host: 0
        };
        const ev = event(next, a, `${payload.amount / 100} DEMO arrived at ${payload.wallet}: ${coverage.reason}. ${v ? 'Provider share is owed, not funded.' : 'Excluded from this agreement.'}`);
        a.arrivals.push({
          id: payload.arrivalId,
          seq: ev.seq,
          at: ev.at,
          amount: payload.amount,
          payer: payload.payer,
          wallet: payload.wallet,
          ...coverage,
          ...shares
        });
        break;
      }
    case 'attest':
      {
        requireThat(role === 'owner', 'Only the owner may acknowledge a reward arrival.');
        const r = a.arrivals.find(r => r.id === payload.arrivalId);
        requireThat(r && r.version !== null, 'Choose a covered arrival.');
        requireThat(payload.arrivalKey === arrivalKey(r), 'Review the exact arrival before acknowledging it.');
        requireThat(!a.attestations.some(t => t.arrivalId === r.id), 'This arrival was already acknowledged.');
        requireThat(!a.ended || next.now + 1 < graceEnd(a), 'The acknowledgment window has closed. Voluntary payment is still possible.');
        a.attestations.push({
          arrivalId: r.id,
          arrivalKey: payload.arrivalKey,
          seq: next.seq + 1,
          at: next.now + 1
        });
        event(next, a, `Owner acknowledged ${r.id} and its provider share (simulated, no signature). Collateral may secure the acknowledged obligation.`);
        break;
      }
    case 'pay':
      {
        requireThat(role === 'owner', 'Only the owner preview can pay the provider.');
        requireThat(Number.isSafeInteger(payload.amount) && payload.amount > 0 && payload.amount <= 100000000, 'Use a positive bounded payment amount.');
        const allocations = allocate(a, next.now + 1, payload.amount, 'owed');
        a.payments.push({
          amount: payload.amount,
          allocations,
          seq: next.seq + 1,
          at: next.now + 1
        });
        event(next, a, `Owner paid ${money(payload.amount)} DEMO to the provider claim. Owner rewards stay in the owner wallet. Deposit top-ups are separate.`);
        break;
      }
    case 'deposit':
      {
        requireThat(role === 'owner', 'Only the owner preview can fund collateral.');
        requireThat(current, 'Accept the terms before funding collateral.');
        requireThat(Number.isSafeInteger(payload.amount) && payload.amount > 0 && payload.amount <= 100000000, 'Use a positive bounded deposit amount.');
        a.deposits.push({
          amount: payload.amount,
          seq: next.seq + 1,
          at: next.now + 1
        });
        event(next, a, `Owner funded ${money(payload.amount)} DEMO refundable security collateral.`);
        break;
      }
    case 'draw-reserve':
      {
        requireThat(role === 'host', 'Only the provider can draw its earned amount from collateral.');
        const amount = Math.min(reserveBalance(a), collectibleDue(a, next.now + 1));
        requireThat(amount > 0, 'No unpaid minimum or owner-acknowledged share is drawable from collateral.');
        const allocations = allocate(a, next.now + 1, amount, 'collectible');
        a.reserveAllocations.push({
          amount,
          allocations,
          seq: next.seq + 1,
          at: next.now + 1
        });
        event(next, a, `${money(amount)} DEMO of collateral allocated to the provider claim. This counts toward this period’s compensation.`);
        break;
      }
    case 'refund':
      {
        requireThat(role === 'owner', 'Only the owner can refund unused collateral.');
        requireThat(a.ended && next.now >= (graceEnd(a) ?? a.ended.at), 'Unused collateral unlocks after exit and the agreed arrival window.');
        const amount = Math.max(0, reserveBalance(a) - collectibleDue(a, next.now + 1));
        requireThat(amount > 0, 'No unused collateral is refundable; authorized amounts owed remain reserved.');
        a.refunds.push({
          amount,
          seq: next.seq + 1,
          at: next.now + 1
        });
        event(next, a, `Owner refunded ${money(amount)} unused DEMO collateral. Provider obligations remain funded or reserved.`);
        break;
      }
    case 'withdraw':
      {
        requireThat(role === 'host', 'Only the provider has an escrow claim; owner rewards stay in the owner wallet.');
        const amount = available(a, role);
        requireThat(amount > 0, 'This side has no funded, unclaimed demo credits.');
        a.withdrawals.push({
          role,
          amount,
          seq: next.seq + 1,
          at: next.now + 1
        });
        event(next, a, `${role} claimed ${money(amount)} funded DEMO credits (simulated).`);
        break;
      }
    case 'end':
      participant(role);
      requireThat(!a.ended, 'This agreement is already ended.');
      endAgreement(next, a, role, 'exit');
      break;
    case 'unlink':
      {
        requireThat(role === 'host', 'Only the host preview may simulate device-signed unlinking.');
        requireThat(a.pairing === 'paired', 'No paired worker to unlink.');
        endAgreement(next, a, role, 'host unlink');
        a.pairing = 'unlinked';
        a.unpairedAt = event(next, a, 'Host simulated unlinking. Future participation stopped.').at;
        if (a.recoveryRequest) a.recoveryRequest.status = 'resolved-in-demo';
        break;
      }
    case 'transfer':
      {
        requireThat(role === 'owner', 'Only the owner preview may simulate moving its NFT.');
        requireThat(a.pairing === 'paired', 'A paired worker is required for the transfer-revoke demonstration.');
        endAgreement(next, a, role, 'NFT transfer');
        a.pairing = 'transfer-pending';
        a.transferRequestedAt = event(next, a, 'Mock NFT transfer: work stopped, network disconnect pending. Developer reports roughly 30 minutes to disconnect after sale; not independently timed.').at;
        break;
      }
    case 'disconnect-transfer':
      {
        requireThat(role === 'demo', 'This is a simulation control, not live disconnect confirmation.');
        requireThat(a.pairing === 'transfer-pending' && next.now >= a.transferRequestedAt + TRANSFER_DELAY, 'Advance the demo clock 30 minutes before simulating disconnect confirmation. Real timing is approximate.');
        a.pairing = 'revoked-by-transfer';
        a.unpairedAt = event(next, a, 'Network disconnect confirmed in the demo. Real integration must observe disconnection, not assume it from a timer.').at;
        if (a.recoveryRequest) a.recoveryRequest.status = 'resolved-in-demo';
        break;
      }
    case 'recovery':
      {
        requireThat(role === 'owner', 'Only the owner preview may request recovery.');
        requireThat(a.ended && a.pairing === 'paired' && !a.recoveryRequest, 'End first; a still-paired worker and no existing request are required.');
        a.recoveryRequest = {
          status: 'requested-in-demo',
          seq: next.seq + 1
        };
        event(next, a, 'Wallet-signed revoke request recorded locally only. This separate direct revoke route is not verified; NFT transfer is the code-supported alternative.');
        break;
      }
    case 'review':
      {
        requireThat(role === 'owner', 'Only the service owner can review this agreement.');
        requireThat(reviewEligible(a, next.now), 'A review requires pairing plus a covered arrival during service, or 24 paired hours.');
        requireThat(Number.isInteger(payload.rating) && payload.rating >= 1 && payload.rating <= 5, 'Choose a rating from 1 to 5.');
        requireThat(typeof payload.comment === 'string' && payload.comment.trim().length >= 10 && payload.comment.length <= 500, 'Write between 10 and 500 characters.');
        a.review = {
          rating: payload.rating,
          comment: payload.comment.trim(),
          createdSeq: a.review?.createdSeq || next.seq + 1,
          updatedSeq: next.seq + 1,
          owner: a.owner
        };
        event(next, a, 'Owner saved a service-linked demo review. Paying funds or receiving payment is not required.');
        break;
      }
    default:
      throw Error('Unknown action.');
  }
  return next;
}
export function demoScenario() {
  let {
    state,
    id
  } = createAgreement(initialState(), {
    hostId: 'northstar',
    nft: '2048',
    ownerBps: 7000,
    wallet: 'demo-wallet-2048',
    dedicatedWallet: true
  });
  for (const role of ['owner', 'host']) state = transition(state, id, 'approve', role, {
    version: 1,
    termsKey: termsKey(state.agreements[0].versions[0])
  });
  state = transition(state, id, 'deposit', 'owner', {
    amount: state.agreements[0].host.securityDeposit
  });
  state = transition(state, id, 'pair', 'demo');
  state = transition(state, id, 'advance', 'demo', {
    ms: 12 * HOUR
  });
  state = transition(state, id, 'arrive', 'demo', {
    arrivalId: 'demo-airdrop-1',
    payer: PAYER,
    wallet: 'demo-wallet-2048',
    amount: 10000
  });
  state = transition(state, id, 'advance', 'demo', {
    ms: 12 * HOUR
  });
  return state;
}

// Restoration checks protect demo usability, not against a user editing their own ledger.
export function restoreState(raw) {
  const s = JSON.parse(raw);
  requireThat(s?.schema === 4 && Number.isSafeInteger(s.seq) && s.seq >= 0 && Number.isSafeInteger(s.now) && s.now >= START_TIME && s.now <= 8640000000000000 && Number.isSafeInteger(s.nextId) && s.nextId >= 1 && Array.isArray(s.hosts) && Array.isArray(s.agreements), 'Saved demo data is incompatible.');
  const hostIds = new Set(),
    ids = new Set(),
    arrivalIds = new Set(),
    events = new Map();
  let maxId = 0,
    maxSeq = 0,
    maxAt = START_TIME;
  const validSeq = n => Number.isSafeInteger(n) && n > 0 && n <= s.seq;
  const validAt = n => Number.isSafeInteger(n) && n > START_TIME && n <= s.now;
  function checkHost(h) {
    requireThat(h && ['id', 'name', 'initials', 'region', 'runtime', 'ai', 'color', 'description', 'service'].every(k => typeof h[k] === 'string') && Array.isArray(h.tools) && h.tools.every(t => typeof t === 'string') && Number.isInteger(h.slots) && h.slots >= 1 && h.slots <= 20 && [h.securityDeposit, h.dailyMinimum].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 100000000) && h.securityDeposit >= h.dailyMinimum, 'Invalid saved host.');
    validSplit(h.ownerBps);
    checkProfile(h.machine, h.skills, h.llmOptions);
  }
  for (const h of s.hosts) {
    checkHost(h);
    requireThat(!hostIds.has(h.id), 'Duplicate host.');
    hostIds.add(h.id);
    if (/^local-\d+$/.test(h.id)) maxId = Math.max(maxId, Number(h.id.slice(6)));
  }
  for (const a of s.agreements) {
    requireThat(a && /^SM-\d+$/.test(a.id) && !ids.has(a.id) && /^\d{1,6}$/.test(a.nft) && /^[a-z0-9-]{3,40}$/.test(a.wallet) && ['owner', 'hostRecipient', 'asset'].every(k => typeof a[k] === 'string') && ['versions', 'arrivals', 'attestations', 'payments', 'withdrawals', 'deposits', 'reserveAllocations', 'refunds', 'history'].every(k => Array.isArray(a[k])) && a.versions.length, 'Invalid saved agreement.');
    checkHost(a.host);
    requireThat(hostIds.has(a.host.id), 'Unknown host.');
    ids.add(a.id);
    maxId = Math.max(maxId, Number(a.id.slice(3)));
    requireThat(a.host.llmOptions.includes(a.llm), 'Invalid saved LLM option.');
    requireThat(a.routing === 'owner-wallet' && ['unpaired', 'paired', 'transfer-pending', 'unlinked', 'revoked-by-transfer'].includes(a.pairing), 'Invalid integration state.');
    requireThat(a.pairedAt === null || validAt(a.pairedAt), 'Invalid pairing time.');
    requireThat(a.unpairedAt === null || validAt(a.unpairedAt) && a.pairedAt !== null && a.unpairedAt > a.pairedAt, 'Invalid unpair time.');
    requireThat(a.pairing === 'unpaired' ? a.pairedAt === null && a.unpairedAt === null : a.pairedAt !== null && (deviceConnected(a) ? a.unpairedAt === null : a.unpairedAt !== null), 'Inconsistent pairing.');
    const transferAt = a.transferRequestedAt ?? null;
    requireThat(transferAt === null || validAt(transferAt) && a.ended && transferAt >= a.ended.at && ['transfer-pending', 'revoked-by-transfer'].includes(a.pairing), 'Invalid transfer request.');
    requireThat(a.pairing !== 'transfer-pending' || transferAt !== null, 'Missing transfer request.');
    requireThat(a.pairing !== 'revoked-by-transfer' || transferAt === null || a.unpairedAt > transferAt + TRANSFER_DELAY, 'Premature demo disconnect.');
    requireThat(a.ended === null || validSeq(a.ended?.seq) && validAt(a.ended.at) && ['owner', 'host'].includes(a.ended.by) && ['exit', 'host unlink', 'NFT transfer'].includes(a.ended.reason), 'Invalid exit.');
    const accepted = [];
    for (const [index, v] of a.versions.entries()) {
      requireThat(v && v.number === index + 1 && ['accepted', 'proposed', 'superseded', 'cancelled'].includes(v.status) && v.approvals && ['owner', 'host'].every(r => typeof v.approvals[r] === 'boolean'), 'Invalid version.');
      validSplit(v.ownerBps);
      requireThat(termsKey(v) === JSON.stringify(snapshotTerms(a, v.ownerBps)), 'Invalid terms snapshot.');
      requireThat(v.status === 'accepted' ? validAt(v.startAt) && v.approvals.owner && v.approvals.host && (v.endAt === null || validAt(v.endAt) && v.endAt > v.startAt) : v.startAt === null && v.endAt === null, 'Invalid version period.');
      if (v.status === 'accepted') accepted.push(v);
    }
    accepted.forEach((v, i) => requireThat(v.endAt === (accepted[i + 1]?.startAt ?? a.ended?.at ?? null), 'Inconsistent version periods.'));
    requireThat(a.versions.filter(v => v.status === 'proposed').length <= 1 && (!a.ended || !pendingVersion(a)), 'Invalid pending terms.');
    for (const r of a.arrivals) {
      requireThat(r && typeof r.id === 'string' && !arrivalIds.has(r.id) && validSeq(r.seq) && validAt(r.at) && Number.isSafeInteger(r.amount) && r.amount > 0 && r.amount <= 100000000 && typeof r.payer === 'string' && typeof r.wallet === 'string', 'Invalid arrival.');
      arrivalIds.add(r.id);
      const coverage = coverageAt(a, r.at, r.payer, r.wallet),
        v = a.versions.find(v => v.number === coverage.version),
        shares = v ? split(r.amount, v.ownerBps) : {
          owner: 0,
          host: 0
        };
      requireThat(['version', 'phase', 'reason'].every(k => r[k] === coverage[k]) && r.owner === shares.owner && r.host === shares.host, 'Invalid arrival attribution.');
    }
    const attested = new Set();
    for (const t of a.attestations) {
      const r = a.arrivals.find(r => r.id === t?.arrivalId);
      requireThat(r && r.version !== null && !attested.has(r.id) && validSeq(t.seq) && validAt(t.at) && t.at > r.at && t.arrivalKey === arrivalKey(r) && (!a.ended || t.at < graceEnd(a)), 'Invalid acknowledgment.');
      attested.add(r.id);
    }
    for (const r of [...a.payments, ...a.deposits, ...a.reserveAllocations, ...a.refunds]) requireThat(r && Number.isSafeInteger(r.amount) && r.amount > 0 && validSeq(r.seq) && validAt(r.at), 'Invalid money movement.');
    const movements = [...a.deposits.map(r => ({
      ...r,
      kind: 'deposit'
    })), ...a.payments.map(r => ({
      ...r,
      kind: 'pay'
    })), ...a.reserveAllocations.map(r => ({
      ...r,
      kind: 'draw'
    })), ...a.refunds.map(r => ({
      ...r,
      kind: 'refund'
    }))].sort((x, y) => x.at - y.at);
    let reserve = 0;
    for (const r of movements) {
      const prior = {
        ...a,
        payments: a.payments.filter(x => x.at < r.at),
        reserveAllocations: a.reserveAllocations.filter(x => x.at < r.at)
      };
      if (r.kind === 'pay' || r.kind === 'draw') {
        const expected = allocate(prior, r.at, r.amount, r.kind === 'pay' ? 'owed' : 'collectible');
        requireThat(JSON.stringify(r.allocations) === JSON.stringify(expected), 'Invalid period payment allocation.');
      }
      if (r.kind === 'refund') requireThat(a.ended && r.at >= (graceEnd(a) ?? a.ended.at) && r.amount <= Math.max(0, reserve - collectibleDue(prior, r.at)), 'Premature or excessive collateral refund.');
      reserve += r.kind === 'deposit' ? r.amount : r.kind === 'pay' ? 0 : -r.amount;
      requireThat(Number.isSafeInteger(reserve) && reserve >= 0, 'Invalid collateral balance.');
    }
    requireThat(sum(a.payments) + sum(a.reserveAllocations) <= hostEntitlement(a, s.now), 'Provider overpaid.');
    for (const w of a.withdrawals) requireThat(w && w.role === 'host' && Number.isSafeInteger(w.amount) && w.amount > 0 && validSeq(w.seq) && validAt(w.at), 'Invalid claim.');
    let balance = 0;
    for (const item of [...a.payments, ...a.reserveAllocations].map(r => ({
      at: r.at,
      delta: r.amount
    })).concat(a.withdrawals.map(r => ({
      at: r.at,
      delta: -r.amount
    }))).sort((x, y) => x.at - y.at)) {
      balance += item.delta;
      requireThat(Number.isSafeInteger(balance) && balance >= 0, 'Claim exceeds funded credits.');
    }
    if (a.review) requireThat(reviewEligible(a, s.now) && Number.isInteger(a.review.rating) && a.review.rating >= 1 && a.review.rating <= 5 && typeof a.review.comment === 'string' && a.review.comment.length >= 10 && a.review.comment.length <= 500 && a.review.owner === a.owner && validSeq(a.review.createdSeq) && validSeq(a.review.updatedSeq) && a.review.updatedSeq >= a.review.createdSeq, 'Invalid saved review.');
    if (a.recoveryRequest) requireThat(a.ended && validSeq(a.recoveryRequest.seq) && (a.recoveryRequest.status === 'requested-in-demo' && deviceConnected(a) || a.recoveryRequest.status === 'resolved-in-demo' && ['unlinked', 'revoked-by-transfer'].includes(a.pairing)), 'Invalid recovery.');
    let prev = 0,
      prevAt = START_TIME;
    const localEvents = new Map();
    for (const ev of a.history) {
      const existing = events.get(ev?.seq);
      requireThat(ev && validSeq(ev.seq) && validAt(ev.at) && ev.seq > prev && ev.at > prevAt && typeof ev.text === 'string' && (!existing || ev.kind === 'clock' && JSON.stringify(existing) === JSON.stringify(ev)), 'Invalid event history.');
      if (ev.kind === 'clock') requireThat(Number.isSafeInteger(ev.ms) && ev.ms > 0 && ev.ms <= 30 * PERIOD, 'Invalid clock event.');
      events.set(ev.seq, ev);
      localEvents.set(ev.seq, ev.at);
      prev = ev.seq;
      prevAt = ev.at;
      maxSeq = Math.max(maxSeq, ev.seq);
      maxAt = Math.max(maxAt, ev.at);
    }
    for (const x of [...a.arrivals, ...a.attestations, ...a.payments, ...a.withdrawals, ...a.deposits, ...a.reserveAllocations, ...a.refunds, ...(a.ended ? [a.ended] : [])]) requireThat(localEvents.get(x.seq) === x.at, 'Ledger event missing.');
  }
  requireThat(Number.isSafeInteger(maxId) && s.nextId > maxId && s.seq === maxSeq && events.size === s.seq && s.now === maxAt, 'Inconsistent clock or identifiers.');
  let lastAt = START_TIME;
  for (const [, ev] of [...events].sort((a, b) => a[0] - b[0])) {
    requireThat(ev.at > lastAt && (ev.kind !== 'clock' || ev.at - lastAt === ev.ms), 'Non-monotonic or inconsistent clock.');
    lastAt = ev.at;
  }
  return s;
}
