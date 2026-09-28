import { percent, money, initialState, createAgreement, createHost, transition, currentVersion, pendingVersion, available, demoScenario, reviewEligible, termsKey, restoreState, HOUR, PAYER, GRACE_HOURS, pairedHours, graceEnd, unfundedHostShare, reserveBalance, serviceMinimum, hostEntitlement, billingPeriods, collectibleDue, unsecuredExposure, pauseRecommended, arrivalKey, deviceConnected, TRANSFER_DELAY } from './model.js';
const app = document.querySelector('#app'),
  dialog = document.querySelector('#dialog'),
  storageKey = 'seat-market.local.v4';
let state = initialState(),
  role = 'owner',
  filter = 'all',
  skillFilter = 'all',
  restoreError = false,
  storageWarning = false,
  knownRaw = null;
const LOOKS = {
  control: { name: 'Control room', number: '01', description: 'Instrument panels, sharp edges, a little green.' },
  ledger: { name: 'Paper ledger', number: '02', description: 'A quieter directory. Clear terms, room to compare.' },
  terminal: { name: 'Terminal', number: '03', description: 'Monospace throughout. Made for the operator.' },
  original: { name: 'Original', number: '00', description: 'The original blue workspace, for comparison.' }
};
let look = 'terminal', theme = 'dark';
try {
  const savedTheme = localStorage.getItem('seat-market.theme');
  if (['dark','light'].includes(savedTheme)) theme = savedTheme;
  const savedLook = localStorage.getItem('seat-market.look');
  if (Object.hasOwn(LOOKS,savedLook)) look = savedLook;
} catch {}
const appearanceQuery = new URLSearchParams(location.search);
if (Object.hasOwn(LOOKS,appearanceQuery.get('look'))) look = appearanceQuery.get('look');
if (['dark','light'].includes(appearanceQuery.get('theme'))) theme = appearanceQuery.get('theme');
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.look = look;
document.documentElement.classList.toggle('imd-look',look!=='original');
try {
  knownRaw = localStorage.getItem(storageKey);
  if (knownRaw) {
    try {
      state = restoreState(knownRaw);
    } catch {
      restoreError = true;
    }
  }
} catch {
  storageWarning = true;
}
const e = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[c]);
const capital = s => s[0].toUpperCase() + s.slice(1);
const button = (label, action, attrs = '', kind = '') => `<button class="button ${kind}" data-action="${action}" ${attrs}>${label}</button>`;
const badge = (label, kind = '') => `<span class="status ${kind}">${label}</span>`;
function minorUnits(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw Error('Use a non-negative amount with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}
function collateralPanel(a) {
  const funds = reserveBalance(a),
    owed = unfundedHostShare(a, state.now),
    minimum = billingPeriods(a, state.now).reduce((n, p) => n + p.minimum, 0);
  const drawable = collectibleDue(a, state.now),
    exposure = unsecuredExposure(a, state.now),
    pause = pauseRecommended(a, state.now);
  const attrs = disabled => 'data-id="' + e(a.id) + '" ' + (disabled ? 'disabled' : '');
  return `<section class="panel"><div class="section-line"><h2>Refundable security deposit</h2>${badge(funds > 0 ? 'Collateral funded' : a.host.securityDeposit === 0 ? 'Not required' : 'Funding needed', funds > 0 ? 'green' : a.host.securityDeposit === 0 ? '' : 'amber')}</div>
    <div class="balance-grid"><div class="balance-card"><span class="field-label">COLLATERAL REMAINING</span><strong>${money(funds)}</strong><span>DEMO · refundable after settlement</span></div><div class="balance-card"><span class="field-label">PRORATED HOSTING MINIMUM</span><strong>${money(minimum)}</strong><span>${money(a.host.dailyMinimum)} DEMO / 24 hours</span></div></div>
    <p class="small-copy">Required before activation: ${money(a.host.securityDeposit)} DEMO. Each 24-hour period earns the greater of its arrival share or prorated minimum. Periods begin at activation and do not reset when the split changes.</p>
    <div class="action-row">${button('Fund / top up deposit (demo)', 'deposit', attrs(role !== 'owner' || !currentVersion(a)), 'primary')}${button('Draw authorized amount from deposit', 'draw-reserve', attrs(role !== 'host' || funds <= 0 || drawable <= 0))}${button('Refund unused deposit', 'refund', attrs(role !== 'owner' || !a.ended || state.now < (graceEnd(a) ?? a.ended.at) || funds <= drawable))}</div>
    <p class="small-copy">${money(drawable)} DEMO is authorized but unpaid: the elapsed-time minimum or owner-acknowledged share, whichever is higher in each period. A draw is limited to the reserve. Top-ups are separate from provider payments.</p>
    ${owed > drawable ? '<div class="note amber"><strong>Owner acknowledgment needed:</strong> ' + money(owed - drawable) + ' DEMO of unpaid share cannot be drawn from the deposit yet. Observing a reward is not authority to take collateral.</div>' : ''}
    <div class="note ${exposure > 0 ? 'amber' : ''}"><strong>Provider exposure:</strong> ${money(exposure)} DEMO owed beyond remaining collateral. ${pause ? 'Pause recommended: request payment or a top-up before providing more service.' : 'Target: pause when unsecured debt reaches one daily minimum; any unsecured debt for a zero-minimum offer.'} This prototype warns only; it does not stop a worker. Collateral also needs draw authority as shown above.</div>
    <p class="small-copy">The minimum bills elapsed agreement time, including downtime, until either party ends. It is not an uptime guarantee. Hosts must stop service promptly after exit. Unused collateral unlocks after the 72-hour window; authorized unpaid amounts remain reserved. Unacknowledged shares cannot block a refund.</p></section>`;
}
function paymentForm(a) {
  const owed = unfundedHostShare(a, state.now);
  showDialog(`<h2 id="dialog-title">Pay the provider</h2><p>Pay only the outstanding provider amount. Your remaining rewards stay in your wallet. This does not top up the deposit or acknowledge any unpaid reward share.</p><form><label>Payment amount (DEMO)<input name="amount" type="number" min="0.01" step="0.01" max="${owed / 100}" value="${owed / 100}" required></label><p class="form-error" role="alert"></p><button class="button primary full" type="submit">Pay provider (demo)</button></form>`);
  dialog.querySelector('form').onsubmit = ev => {
    ev.preventDefault();
    try {
      state = transition(state, a.id, 'pay', role, {
        amount: minorUnits(new FormData(ev.currentTarget).get('amount'))
      });
      save();
      dialog.close();
      render();
      toast('Provider payment funded.');
    } catch (error) {
      formError(error.message);
    }
  };
}
function attestForm(a) {
  const r = a.arrivals.find(r => r.version !== null && !a.attestations.some(t => t.arrivalId === r.id));
  if (!r) return;
  const key = arrivalKey(r);
  showDialog(`<h2 id="dialog-title">Acknowledge reward arrival</h2><p>${e(r.id)} · ${timeLabel(r.at)} · ${e(r.payer)} → ${e(r.wallet)}</p><div class="note">${money(r.amount)} DEMO received; ${money(r.host)} provider share under terms v${r.version}. This authorizes the unpaid share against collateral for this billing period. It does not move money.</div><form><label class="checkbox-label"><input type="checkbox" required> I acknowledge this exact arrival and share as the owner (simulated; no wallet signature).</label><p class="form-error" role="alert"></p><button class="button primary full" type="submit">Acknowledge arrival (demo)</button></form>`);
  dialog.querySelector('form').onsubmit = ev => {
    ev.preventDefault();
    try {
      state = transition(state, a.id, 'attest', role, {
        arrivalId: r.id,
        arrivalKey: key
      });
      save();
      dialog.close();
      render();
      toast('Owner acknowledgment recorded.');
    } catch (error) {
      formError(error.message);
    }
  };
}
function depositForm(a) {
  showDialog(`<h2 id="dialog-title">Fund security collateral</h2><p>This holds local DEMO credits against the agreed hosting minimum and provider share. It creates no real payment.</p><form><label>Deposit amount (DEMO)<input name="amount" type="number" min="0.01" step="0.01" max="1000000" value="${Math.max(1, a.host.securityDeposit) / 100}" required></label><p class="form-error" role="alert"></p><button class="button primary full" type="submit">Fund demo collateral</button></form>`);
  dialog.querySelector('form').onsubmit = ev => {
    ev.preventDefault();
    try {
      state = transition(state, a.id, 'deposit', role, {
        amount: minorUnits(new FormData(ev.currentTarget).get('amount'))
      });
      save();
      dialog.close();
      render();
      toast('Demo collateral funded.');
    } catch (error) {
      formError(error.message);
    }
  };
}
function save() {
  let latest;
  try {
    latest = localStorage.getItem(storageKey);
  } catch {
    storageWarning = true;
    return;
  }
  if (latest !== knownRaw) {
    knownRaw = latest;
    try {
      state = latest ? restoreState(latest) : initialState();
    } catch {
      state = initialState();
      restoreError = true;
    }
    if (dialog.open) dialog.close();
    render();
    throw Error('Another tab changed the demo. Its latest state was loaded; please review before retrying.');
  }
  try {
    const serialized = JSON.stringify(state);
    localStorage.setItem(storageKey, serialized);
    knownRaw = serialized;
    storageWarning = false;
  } catch {
    storageWarning = true;
  }
}
window.addEventListener('storage', event => {
  if (event.key === storageKey) {
    knownRaw = event.newValue;
    try {
      state = knownRaw ? restoreState(knownRaw) : initialState();
      restoreError = false;
    } catch {
      state = initialState();
      restoreError = true;
    }
    if (dialog.open) dialog.close();
    render();
    toast('Another tab updated the demo. Open form drafts were closed; review the latest terms before acting.');
  }
});
let toastTimer;
function toast(text) {
  document.querySelector('#toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => document.querySelector('#toast').textContent = '', 5000);
}
function route() {
  return location.hash.slice(1) || 'hosts';
}
function go(path) {
  if (route() === path) render();else location.hash = path;
}
function getAgreement() {
  return state.agreements.find(a => a.id === route().split('/')[1]);
}
function act(id, action, actor, payload = {}) {
  try {
    state = transition(state, id, action, actor, payload);
    save();
    render();
    toast('Demo updated. No live action was taken.');
  } catch (error) {
    toast(error.message);
  }
}
function proposals(hostId, nft, ownerPercent, wallet, dedicatedWallet) {
  const result = createAgreement(state, {
    hostId,
    nft,
    ownerBps: Number(ownerPercent) * 100,
    wallet,
    dedicatedWallet
  });
  state = result.state;
  save();
  go(`agreement/${result.id}`);
  return result.id;
}
function showDialog(html) {
  dialog.innerHTML = `<div class="dialog-head"><span class="eyebrow">LOCAL SIMULATION</span><button class="icon-button" data-close aria-label="Close dialog">×</button></div>${html}`;
  dialog.querySelectorAll('[data-close]').forEach(b => b.onclick = () => dialog.close());
  dialog.showModal();
}
function formError(message) {
  const target = dialog.querySelector('[role="alert"]');
  if (dialog.open && target) target.textContent = message;else toast(message);
}
function ratingSummary(id) {
  const reviews = state.agreements.filter(a => a.host.id === id && a.review).map(a => a.review);
  return reviews.length ? `★ ${(reviews.reduce((n, r) => n + r.rating, 0) / reviews.length).toFixed(1)} · ${reviews.length} demo review${reviews.length === 1 ? '' : 's'}` : 'No service reviews yet';
}
function reviewPanel(a) {
  const eligible = reviewEligible(a, state.now);
  return `<section class="panel"><div class="section-line"><h2>Service review</h2>${badge(eligible ? 'Demo usage recorded' : a.ended ? 'Not eligible' : 'Usage needed', eligible ? 'blue' : '')}</div>${a.review ? `<div class="review-content"><strong class="stars">${'★'.repeat(a.review.rating)}${'☆'.repeat(5 - a.review.rating)}</strong><p>${e(a.review.comment)}</p><span>Demo owner · linked to ${e(a.id)}</span></div>` : `<p class="small-copy">${eligible ? 'You can review this provider without paying or receiving rewards.' : 'Qualifying service requires an arrival while paired and before exit, or 24 paired hours before exit. Grace-window arrivals do not establish service use.'}</p>`}<div class="action-row review-actions">${button(a.review ? 'Edit your review' : 'Rate this provider', 'review', `data-id="${e(a.id)}" ${role !== 'owner' || !eligible ? 'disabled' : ''}`)}</div><p class="small-copy">One editable review per agreement. Eligibility is simulated here; no reviewer or host is verified.</p></section>`;
}
function reviewForm(a) {
  showDialog(`<h2 id="dialog-title">Rate ${e(a.host.name)}</h2><p>Your review is linked to ${e(a.id)} and its recorded demo use. Receiving a payout is not required.</p><form><label>Service rating<select name="rating" required>${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${a.review?.rating === n ? 'selected' : ''}>${n} / 5 ${n === 5 ? '— Excellent' : n === 1 ? '— Poor' : ''}</option>`).join('')}</select></label><label>Your experience<textarea name="comment" minlength="10" maxlength="500" rows="4" required placeholder="How did the provider handle service and payment?">${e(a.review?.comment || '')}</textarea></label><p class="form-error" role="alert"></p><button class="button primary full" type="submit">Save demo review</button></form>`);
  dialog.querySelector('form').onsubmit = ev => {
    ev.preventDefault();
    const data = new FormData(ev.currentTarget);
    try {
      state = transition(state, a.id, 'review', role, {
        rating: Number(data.get('rating')),
        comment: data.get('comment')
      });
      save();
      dialog.close();
      render();
      toast('Service review saved locally.');
    } catch (error) {
      formError(error.message);
    }
  };
}
function hostReviews(id) {
  const h = state.hosts.find(h => h.id === id),
    rows = state.agreements.filter(a => a.host.id === id && a.review);
  showDialog(`<h2 id="dialog-title">${e(h.name)} reviews</h2><p>These reviews are tied to example agreements with recorded use. They are local demonstrations, not verified customers.</p>${rows.length ? rows.map(a => `<article class="review-content"><strong class="stars">${'★'.repeat(a.review.rating)}${'☆'.repeat(5 - a.review.rating)}</strong><p>${e(a.review.comment)}</p><span>Demo NFT #${e(a.nft)} · ${e(a.id)} · ${a.ended ? 'ended' : 'open'} agreement</span></article>`).join('') : '<div class="note">No service reviews yet. A host cannot review its own service.</div>'}`);
}
function machineLabel(h) {
  return h.machine.cpu + ' vCPU · ' + h.machine.ramGb + ' GB RAM · ' + h.machine.diskGb + ' GB disk';
}
function card(host) {
  const occupied = state.agreements.filter(a => a.host.id === host.id && (!a.ended || deviceConnected(a))).length;
  return `<article class="host-card"><div class="card-top"><span class="avatar ${e(host.color)}">${e(host.initials)}</span><span class="pill">${Math.max(0, host.slots - occupied)} example slots</span></div><h3>${e(host.name)}</h3><div class="location">${e(host.region)} · ${e(host.runtime)}</div><p class="host-description">${e(host.description)}</p><div class="machine-spec">${e(machineLabel(host))}<span>Advertised shared machine</span></div><div class="tool-row">${host.skills.map(s => '<span>' + e(s) + '</span>').join('')}</div><div class="split-row"><div><span class="field-label">OWNER REWARD SHARE</span><strong>${percent(host.ownerBps)}</strong></div><div class="host-share"><span class="field-label">PROVIDER REWARD SHARE</span><strong>${percent(10000 - host.ownerBps)}</strong></div></div><div class="offer-protection"><span>${money(host.securityDeposit)} DEMO deposit</span><span>${money(host.dailyMinimum)} / day minimum</span></div><p class="small-copy">The minimum may reduce the owner’s net rewards below the advertised share.</p>${button(ratingSummary(host.id), 'reviews', `data-id="${e(host.id)}"`, 'rating-link')}<div class="ai-row"><span>${host.llmOptions.length} LLM option${host.llmOptions.length === 1 ? '' : 's'}</span><strong>${e(host.ai)}</strong></div><div class="card-actions">${button('Provider profile', 'profile', `data-id="${e(host.id)}"`, 'full')}${button('Review offer ↗', 'offer', `data-id="${e(host.id)}" ${occupied >= host.slots ? 'disabled' : ''}`, 'primary full')}</div></article>`;
}
function hostProfile(id) {
  const h = state.hosts.find(h => h.id === id);
  if (!h) return;
  showDialog(`<h2 id="dialog-title">${e(h.name)}</h2><p>${e(h.description)}</p><div class="note amber">Fictional provider profile. Hardware, skills, capacity and model access are advertised claims, not verified benchmarks.</div><dl class="terms-grid"><div><dt>Shared machine</dt><dd>${e(machineLabel(h))}</dd></div><div><dt>Region / runtime</dt><dd>${e(h.region)} / ${e(h.runtime)}</dd></div><div><dt>Advertised skills</dt><dd>${h.skills.map(e).join(', ')}</dd></div><div><dt>Runtime tools</dt><dd>${h.tools.map(e).join(', ')}</dd></div><div><dt>LLM options</dt><dd>${h.llmOptions.map(e).join('<br>')}</dd></div><div><dt>AI access</dt><dd>${e(h.ai)} · provider permission unverified</dd></div><div><dt>Deposit / daily minimum</dt><dd>${money(h.securityDeposit)} / ${money(h.dailyMinimum)} DEMO</dd></div><div><dt>Owner / provider split</dt><dd>${percent(h.ownerBps)} / ${percent(10000 - h.ownerBps)}</dd></div></dl><h3>Support & service commitment</h3><p>${e(h.service)}</p><p>Machine resources may be shared across slots. The agreement must specify resource allocation, model access and quota limits. A listing does not verify any of them.</p><button class="button primary full" id="profile-offer">Review this offer</button>`);
  dialog.querySelector('#profile-offer').onclick = () => {
    dialog.close();
    offer(id);
  };
}
function hostsView() {
  const hosts = state.hosts.filter(h => (filter === 'all' || h.runtime === filter) && (skillFilter === 'all' || h.skills.includes(skillFilter)));
  const skills = [...new Set(state.hosts.flatMap(h => h.skills))].sort();
  return `${directoryHeading()}${demoBanner()}<div class="directory-layout"><section><div class="section-line host-filters"><h2>Available hosts <span class="count">${hosts.length}</span></h2><label class="filter-label">Runtime <select id="runtime-filter"><option value="all">All runtimes</option><option ${filter === 'Codex' ? 'selected' : ''}>Codex</option><option ${filter === 'Claude' ? 'selected' : ''}>Claude</option></select></label><label class="filter-label">Skill <select id="skill-filter"><option value="all">All skills</option>${skills.map(s => '<option ' + (skillFilter === s ? 'selected' : '') + '>' + e(s) + '</option>').join('')}</select></label></div><div class="host-grid">${hosts.length ? hosts.map(card).join('') : '<div class="empty"><h2>No matching offers.</h2><p>Change the runtime or skill filter.</p></div>'}</div></section><aside class="explainer"><span class="eyebrow">HOW IT WORKS TODAY</span><h2>Your NFT.<br>Their machine.<br>Agreed protection.</h2><ol class="steps"><li><span>01</span><div><strong>Compare the offer</strong><p>Machine, advertised skills, LLM access and support.</p></div></li><li><span>02</span><div><strong>Agree and fund</strong><p>Both parties approve the split, deposit and hosting minimum.</p></div></li><li><span>03</span><div><strong>Owner receives rewards</strong><p>Pay the provider’s amount; acknowledge shares before collateral can cover them.</p></div></li></ol><div class="note">Listings and collateral are simulated. Owner-wallet payouts still involve trust.</div><a class="text-link" href="#guide">Understand the trust model ↗</a></aside></div>`;
}
function appearanceBar() {
  return `<section class="appearance-bar" aria-label="Visual directions"><div class="appearance-label"><span class="appearance-dot" aria-hidden="true"></span><span>LOOK & FEEL</span></div><div class="look-options" role="group" aria-label="Choose a visual direction">${Object.entries(LOOKS).map(([id,item])=>`<button class="look-option" data-action="look" data-id="${id}" data-look-choice="${id}" aria-pressed="${look===id}"><span aria-hidden="true">${item.number}</span>${item.name}</button>`).join('')}</div><p>${LOOKS[look].description}</p></section>`;
}
function directoryHeading() {
  if(look==='original')return `<div class="page-heading"><div><div class="eyebrow">INDEPENDENT HOSTS</div><h1>Find a home for your worker.</h1><p>Compare machines, skills, LLM options, and service terms.</p></div>${button('Advertise a demo host','list')}</div>`;
  return `<section class="directory-hero"><div class="hero-copy"><div class="eyebrow"><span class="signal-mark" aria-hidden="true"></span> INDEPENDENT HOSTING / IMD COMMUNITY</div><h1>Your NFT.<br><span>Their machine.</span></h1><p>Find the right operator. Agree your share.<br>Keep your NFT and your rewards in your wallet.</p><div class="hero-actions">${button('Advertise a demo host ↗','list','','primary')}<a class="text-link" href="#guide">How it works <span aria-hidden="true">→</span></a></div></div><div class="hero-console" aria-hidden="true"><div class="rack-caption"><span>SEAT MARKET / HOSTING CONSOLE</span><span>◇ 001</span></div>${consoleDrawing()}<div class="console-footer"><span>01 DISCOVER</span><span>02 AGREE</span><span>03 HOST</span></div></div><div class="terminal-intro" aria-hidden="true"><div class="terminal-line">$ seat-market find-host</div><div>owner.wallet &nbsp; → &nbsp; rewards</div><div>provider.host → &nbsp; compute</div><div class="terminal-divider">──────────────────────────</div><div>YOUR KEYS. YOUR SEAT.</div><div>TERMS YOU BOTH AGREE TO.<span class="terminal-cursor">▌</span></div></div><div class="ledger-stamp" aria-hidden="true"><span>HOST DIRECTORY</span><strong>SM / 01</strong><span>INDEPENDENT OPERATORS<br>SHARED TERMS</span></div></section>`;
}
function consoleDrawing() {
  const leds=Array.from({length:20},(_,i)=>`<rect x="${278+(i%5)*19}" y="${31+Math.floor(i/5)*18}" width="11" height="10" class="${[0,1,3,6,7,10,12,13,15,16,17].includes(i)?'rack-led':'rack-muted'}"/>`).join('');
  const bars=Array.from({length:15},(_,i)=>`<path d="M ${33+i*13} 162 v -${[14,26,21,44,34,51,37,56,45,27,40,61,53,67,57][i]}" class="rack-bar"/>`).join('');
  return `<svg viewBox="0 0 440 208" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="438" height="206" class="rack-shell"/><g class="rack-line"><rect x="14" y="14" width="233" height="65"/><rect x="261" y="14" width="165" height="96"/><rect x="14" y="91" width="233" height="99"/><rect x="261" y="122" width="165" height="68"/><path d="M 28 46 H 63 L 76 32 L 88 61 L 104 38 L 117 49 H 231" class="rack-wave"/><path d="M 28 70 H 231 M 28 168 H 233 M 325 134 V 178 M 366 134 V 178"/>${leds}${bars}<circle cx="292" cy="155" r="20"/><path d="M 292 155 l 10 -12" class="rack-pointer"/><circle cx="292" cy="155" r="3"/><path d="M 338 140 H 354 M 338 149 H 354 M 338 158 H 354 M 338 167 H 354 M 382 139 H 410 M 382 149 H 410 M 382 159 H 410 M 382 169 H 410"/><path d="M 268 100 H 418"/></g><g class="rack-screw"><circle cx="6" cy="6" r="2"/><circle cx="434" cy="6" r="2"/><circle cx="6" cy="202" r="2"/><circle cx="434" cy="202" r="2"/></g></svg>`;
}
function demoBanner() {
  return `<div class="demo-banner"><span class="info-symbol">i</span><span><strong>A working idea, with example data.</strong> Hosts, capacity, and rewards are fictional. Everything stays in this browser.</span></div>`;
}
function agreementStatus(a) {
  return a.ended ? 'Ended' : currentVersion(a) ? 'Terms accepted' : 'Awaiting approval';
}
function agreementsView() {
  return `<div class="page-heading"><div><div class="eyebrow">YOUR ARRANGEMENTS</div><h1>Every seat, accounted for.</h1><p>Agreement, routing, and pairing are separate facts.</p></div>${button('Load lifecycle example', 'example')}</div>${demoBanner()}${!state.agreements.length ? `<section class="empty"><div class="empty-mark">≡</div><h2>No agreements yet.</h2><p>Choose a host to make a proposal, or load an example with pending rewards.</p><a class="button primary" href="#hosts">Find a host ↗</a></section>` : `<div class="agreement-list">${state.agreements.map(a => {
    const v = currentVersion(a) || pendingVersion(a) || a.versions.at(-1);
    return `<a class="agreement-row" href="#agreement/${a.id}"><span class="avatar ${e(a.host.color)}">${e(a.host.initials)}</span><div class="agreement-title"><strong>Demo NFT #${e(a.nft)}</strong><span>${e(a.host.name)} · ${e(a.id)}</span></div>${badge(agreementStatus(a), a.ended ? '' : 'blue')}<div class="row-share"><strong>${percent(v.ownerBps)}</strong><span>owner share</span></div><span class="row-arrow">↗</span></a>`;
  }).join('')}</div>`}`;
}
function termsRows(a, v) {
  const t = v.terms;
  const rows = [['Seat', 'Demo NFT #' + t.seat], ['Host / runtime', a.host.name + ' / ' + t.runtime], ['Owner recipient', t.owner], ['Provider recipient', t.provider], ['Dedicated receiving wallet', t.wallet], ['Covered payer / asset', t.source + ' / ' + t.asset], ['Owner / provider share', percent(t.ownerBps) + ' / ' + percent(10000 - t.ownerBps)], ['Attribution', 'Arrival time; active service and the agreed exit window only'], ['Exit window', t.graceHours + ' hours; deadline excluded'], ['Funding', 'Owner receives rewards and pays only provider compensation'], ['Shared machine', t.machine.cpu + ' vCPU / ' + t.machine.ramGb + ' GB RAM / ' + t.machine.diskGb + ' GB disk'], ['Advertised skills', t.skills.join(', ')], ['Selected LLM option', t.llm], ['Required deposit', money(t.securityDeposit) + ' DEMO'], ['Daily hosting minimum', money(t.dailyMinimum) + ' DEMO'], ['Billing periods', 'Fixed 24 hours from activation; each period earns max(share, prorated minimum)'], ['Minimum basis', 'Elapsed agreement time, including downtime, until either party ends. This is not uptime billing.'], ['Worked example', '100 DEMO received in day 1, then 14 zero-reward days: ' + money(Math.max(10000 - t.ownerBps, t.dailyMinimum)) + ' + 14 × ' + money(t.dailyMinimum) + ' = ' + money(Math.max(10000 - t.ownerBps, t.dailyMinimum) + 14 * t.dailyMinimum) + ' DEMO owed'], ['Draw authority', 'Elapsed-time minimum or owner-acknowledged share per period. Acknowledgments close at the exit-window deadline.'], ['Price changes', 'Split-only amendments; deposit and minimum changes require a new agreement'], ['AI arrangement', t.ai + ' · permission unverified'], ['Service commitment', t.service], ['Rounding rule', 'Whole minor units; share remainder to provider; partial minimum rounded down'], ['Exit rule', 'Either party ends. Minimum stops; final split covers matching arrivals before exit + 72h. Unused collateral refundable; authorized debt stays reserved.']];
  return '<dl class="terms-grid">' + rows.map(([label, value]) => '<div><dt>' + e(label) + '</dt><dd>' + e(value) + '</dd></div>').join('') + '</dl>';
}
function timeLabel(at) {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
function agreementView(a) {
  if (!a) return '<section class="empty"><h1>Agreement not found.</h1><a href="#agreements" class="button">Back to agreements</a></section>';
  const v = currentVersion(a),
    p = pendingVersion(a),
    display = p || v || a.versions.at(-1),
    unacknowledged = a.arrivals.filter(r => r.version !== null && !a.attestations.some(t => t.arrivalId === r.id));
  const attrs = (disabled = false) => 'data-id="' + e(a.id) + '" ' + (disabled ? 'disabled' : '');
  const pairingLabel = {
    'unpaired': 'Not paired',
    'paired': 'Paired in demo',
    'unlinked': 'Unlinked in demo',
    'transfer-pending': 'Work stopped · disconnect pending',
    'revoked-by-transfer': 'Disconnected after transfer (demo)'
  }[a.pairing];
  return `<div class="page-heading"><div><div class="eyebrow"><a href="#agreements">AGREEMENTS</a> / ${e(a.id)}</div><h1>Demo NFT #${e(a.nft)} <span class="heading-light">× ${e(a.host.name)}</span></h1><p>${a.ended ? 'Participation ended. Funded claims and existing payment obligations remain.' : 'Both parties approve terms for reward arrivals to a dedicated owner wallet.'}</p></div>${badge(agreementStatus(a), a.ended ? '' : 'blue')}</div>
  <div class="note amber"><strong>Today, the owner receives the rewards.</strong> The provider relies on the owner to pay and acknowledge its share. Observed arrivals show obligations; claims need provider payments or authorized deposit draws.</div>
  ${a.ended && a.pairing === 'paired' ? '<div class="note amber">The device remains paired after exit. Host unlink or an owner NFT transfer can revoke it. Transfer behavior is supported by worker code; live validation is pending.</div>' : ''}
  ${a.pairing === 'transfer-pending' ? '<div class="note amber"><strong>Work stopped; network disconnect pending.</strong> The developer reports that a sold, paired NFT stops work and accepting tasks, then disconnects after roughly 30 minutes. This is reported behavior, not a measured deadline. Confirm the disconnect before rehosting in this demo.</div>' : ''}
  <div class="status-grid"><div><span class="field-label">01 · AGREEMENT</span><strong>${v ? 'Both sides accepted' : a.ended ? 'Proposal closed' : 'Approval needed'}</strong><span>${v ? 'Arrival terms v' + v.number : 'Each side approves separately'}</span></div><div><span class="field-label">02 · PAYOUT DESTINATION</span><strong>Owner wallet</strong><span>Delegated, locked routing is proposed</span></div><div><span class="field-label">03 · DEVICE</span><strong>${pairingLabel}</strong><span>No live device involved</span></div></div>
  <div class="agreement-layout"><div><section class="panel"><div class="section-line"><h2>${p ? 'Proposed' : 'Agreement'} terms · v${display.number}</h2>${badge(p ? 'Needs both approvals' : 'Locked version (local)', p ? 'amber' : '')}</div>
  ${p && v ? '<div class="note">Current arrival terms remain ' + percent(v.ownerBps) + ' / ' + percent(10000 - v.ownerBps) + ' until both parties accept.</div>' : ''}${termsRows(a, display)}
  <div class="terms-note"><strong>Arrival time decides the split</strong><p>Airdrops do not identify the jobs or earning period. Earlier work paid after an amendment uses the terms at arrival. The proposed 72-hour exit window uses the last accepted split and excludes the exact deadline. It is not an IMD payout guarantee.</p></div>
  <div class="approval-row">${badge(display.approvals.owner ? '✓ Owner approved' : '○ Owner pending', display.approvals.owner ? 'green' : '')}${badge(display.approvals.host ? '✓ Provider approved' : '○ Provider pending', display.approvals.host ? 'green' : '')}</div>
  <div class="action-row">${p && !a.ended ? button(display.approvals[role] ? capital(role) + ' already approved' : 'Review & approve as ' + role, 'approve', attrs(display.approvals[role]), 'primary') : ''}${p && v && !a.ended ? button('Discard amendment', 'discard', attrs()) : ''}${!a.ended ? button(p ? 'Counter-propose a split' : 'Propose a new split', 'amend', attrs()) : ''}${!a.ended ? button(v ? 'End future participation' : 'Close proposal', 'end', attrs(), 'danger') : ''}</div></section>
  ${collateralPanel(a)}<section class="panel"><div class="section-line"><h2>Reward arrivals & funding</h2><span class="muted">DEMO · no cash value</span></div>
  <div class="note amber"><strong>${money(unfundedHostShare(a, state.now))} DEMO owed to provider, not funded.</strong> ${unacknowledged.length} covered arrival(s) lack owner acknowledgment.</div>
  <div class="balance-grid"><div class="balance-card"><span class="field-label">PROVIDER · FUNDED CLAIMABLE</span><strong>${money(available(a, 'host'))}</strong><span>Provider payments + authorized deposit draws</span>${button('Claim as host', 'withdraw', attrs(role !== 'host' || available(a, 'host') <= 0), 'small')}</div><div class="balance-card"><span class="field-label">OWNER REWARDS</span><strong>Stay in your wallet</strong><span>There is no owner reward withdrawal from this app.</span></div></div>
  <div class="action-row">${button('Pay provider (demo)', 'pay', attrs(role !== 'owner' || unfundedHostShare(a, state.now) <= 0), 'primary')}${button('Review & acknowledge next arrival', 'attest', attrs(role !== 'owner' || !unacknowledged.length || a.ended && state.now + 1 >= graceEnd(a)))}</div>
  <p class="small-copy">Pay part or all of what is owed. Payments and deposit draws credit the oldest outstanding billing periods; they never pay a period twice. Top up collateral separately. Owner acknowledgment authorizes a share draw but funds nothing. Voluntary payments remain possible after the acknowledgment window closes.</p>
  ${a.arrivals.length ? '<div class="table-scroll"><table><thead><tr><th>Arrival / UTC</th><th>Coverage</th><th>Owner / provider share</th><th>Acknowledgment</th></tr></thead><tbody>' + a.arrivals.map(r => '<tr><td>' + e(r.id) + '<br>' + timeLabel(r.at) + '</td><td>' + (r.version === null ? e(r.reason) : 'v' + r.version + ' · ' + r.phase) + '</td><td>' + (r.version === null ? 'Excluded' : money(r.owner) + ' / ' + money(r.host)) + '</td><td>' + (r.version === null ? '—' : a.attestations.some(t => t.arrivalId === r.id) ? 'Owner acknowledged' : 'Unacknowledged') + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">No reward arrivals recorded.</p>'}
  ${a.pairedAt !== null ? '<h3>Billing periods</h3><p class="small-copy">24-hour periods from ' + timeLabel(a.pairedAt) + '. The current period is partial. Grace arrivals use their arrival period; service minimum is zero after exit.</p><div class="table-scroll"><table><thead><tr><th>Period</th><th>Minimum</th><th>Share</th><th>Total earned</th><th>Funded</th><th>Unpaid</th></tr></thead><tbody>' + billingPeriods(a, state.now).map(p => '<tr><td>' + String(p.index + 1) + '</td><td>' + money(p.minimum) + '</td><td>' + money(p.share) + '</td><td>' + money(p.entitlement) + '</td><td>' + money(p.funded) + '</td><td>' + money(p.owed) + '</td></tr>').join('') + '</tbody></table></div>' : ''}
  ${a.ended && v ? '<p class="small-copy">Exit window closes ' + timeLabel(graceEnd(a)) + ' (exclusive). Only the original payer and receiving wallet qualify.</p>' : ''}
  </section>${reviewPanel(a)}<section class="panel"><h2>History</h2><ol class="timeline">${a.history.slice().reverse().map(ev => '<li><span>' + ev.seq + '</span><p>' + e(ev.text) + '<br><small>' + timeLabel(ev.at) + '</small></p></li>').join('')}</ol></section></div>
  <aside><section class="panel simulation"><span class="eyebrow">TRY THE LIFECYCLE</span><h2>Simulation controls</h2><p>Demo time: <strong>${timeLabel(state.now)}</strong><br>${pairedHours(a, state.now).toFixed(1)} paired hours. Clock changes affect all agreements.</p>
  ${v && !a.ended && a.pairing === 'unpaired' && reserveBalance(a) < a.host.securityDeposit ? '<div class="note">Fund the ' + money(a.host.securityDeposit) + ' DEMO security deposit above to enable pairing.</div>' : ''}${button('Simulate worker pairing', 'pair', attrs(!v || a.ended || a.pairing !== 'unpaired' || reserveBalance(a) < a.host.securityDeposit), 'full')}${button('Advance demo clock 24 hours', 'advance', attrs(), 'full')}${button('Record 100 DEMO arrival', 'arrive', attrs(), 'full')}${button('Record unrelated payer arrival', 'other-arrival', attrs(), 'full')}
  <div class="note">Arrivals use the displayed clock and ${e(a.wallet)}. They do not fund provider claims or authorize collateral draws.</div>
  ${button('Move NFT to revoke (demo)', 'transfer', attrs(role !== 'owner' || a.pairing !== 'paired'), 'full')}${button('Simulate host unlink', 'unlink', attrs(role !== 'host' || a.pairing !== 'paired'), 'full')}${button('Request direct wallet revoke (demo)', 'recovery', attrs(role !== 'owner' || !a.ended || a.pairing !== 'paired' || a.recoveryRequest), 'full')}
  ${a.pairing === 'transfer-pending' ? button('Advance demo clock 30 minutes', 'advance-disconnect', attrs(), 'full') + button('Confirm disconnected (demo)', 'disconnect-transfer', attrs(state.now < a.transferRequestedAt + TRANSFER_DELAY), 'full') : ''}
  ${a.recoveryRequest ? '<div class="note">' + (a.recoveryRequest.status === 'resolved-in-demo' ? 'Device access ended in the demo; request closed.' : 'Request stored locally only. The device remains paired.') + '</div>' : ''}</section>
  <section class="panel"><h2>Revoke hosting access</h2><p class="small-copy">Provider unlink is one route. A direct owner-authorized revoke may also be available; it has not been verified here. The sale report does not mean selling is required to leave.</p><p class="small-copy">Worker code treats NFT transfer as a stale enrollment and terminal disconnect. The developer reports that a sale stops work and task acceptance, then disconnects the server after roughly 30 minutes. The demo distinguishes those stages and waits for simulated disconnect confirmation before rehosting. Agent identity and moving the token back remain untested.</p><p class="small-copy">A transfer can also change future reward destinations. The grace rule cannot capture rewards sent to a different wallet.</p><a class="text-link" href="#guide">Trust model & proposed integrations ↗</a></section></aside></div>`;
}
function guideView() {
  return `<div class="page-heading"><div><div class="eyebrow">THE OPERATING MODEL</div><h1>The host needs payment protection.</h1><p>The owner holds the NFT and currently receives its IMD rewards.</p></div></div><div class="guide-grid">
  <section class="panel"><h2>Try the corrected lifecycle</h2><ol class="guide-list"><li>Load the 70/30 example: 100 DEMO arrived in the owner wallet, with 30 owed to the host and zero funded claims.</li><li>As owner, acknowledge the exact arrival to authorize its share against collateral, or pay the provider directly. Your other rewards stay in your wallet.</li><li>Amend the split with both approvals. A subsequent arrival uses the new split, regardless of when work happened.</li><li>End participation. Matching arrivals before the 72-hour deadline use the final terms; later arrivals are excluded.</li><li>Try owner transfer-revoke, or host unlink. Funded balances remain claimable.</li></ol>${button('Load lifecycle example', 'example', '', 'primary')}</section>
  <section class="panel"><h2>What today's evidence supports</h2><p>Recorded mainnet Disperse distributions paid the NFT holder wallet. The provider relies on the owner to pay its share. Three observed payouts do not promise a schedule or bound how long a provider may go unpaid.</p><p>The September 23 payout aggregated multiple seats in one wallet. This v1 therefore requires one hosted NFT per dedicated receiving wallet, without other seats or mixed eligible rewards. A wallet label in this demo is only a declaration.</p></section>
  <section class="panel"><h2>Arrival rules, agreed in advance</h2><p>Only the specified payer, asset and wallet are covered. The version active when funds arrive determines the split. There is no per-job or earning-period attribution in these airdrops.</p><p>After exit, the final split covers arrivals for 72 hours, excluding the exact deadline. This proposed term is not an IMD guarantee. Do not reuse the wallet for another service during that window.</p><div class="note">An arrival shows what is owed. Provider payments and authorized collateral draws show what can be claimed.</div></section>
  <section class="panel"><h2>Owner exit and device authority</h2><p>Worker code marks a transferred NFT's enrollment stale and treats <code>nft_transferred</code> as terminal. Moving the NFT to another controlled wallet is a code-supported way to revoke without the host. The developer reports that after sale the server stops work and accepting tasks, then disconnects roughly 30 minutes later. That timing is reported, not independently measured.</p><p>A live test is still pending: does the agent ID persist, and can moving back revive the old enrollment? A separate wallet-signed direct revoke route remains unverified. Ending this agreement alone does not revoke the device.</p></section>
  <section class="panel"><h2>Deposit protection, with explicit trust</h2><p>Each fixed 24-hour period earns the greater of its reward share or elapsed-time minimum. A day-1 share of 30 DEMO followed by 14 zero-reward days at 2/day totals 58 DEMO. The minimum includes downtime until either side ends; it is not measured uptime.</p><p>The provider can draw the unpaid minimum or owner-acknowledged share from collateral. Observations alone cannot authorize share draws. Unacknowledged shares cannot freeze the refund after 72 hours; acknowledgment must arrive before that deadline. The owner can still pay voluntarily afterward. Top-ups are separate.</p><p>Target no more than one unsecured day before pausing service. The exposure warning includes all unpaid compensation minus remaining collateral. Missing owner acknowledgments are shown separately. A real host-side stop rule and a dispute process remain to be built. The deposit only protects up to the funded amount.</p></section><section class="panel"><h2>Future delegation, not the current plan</h2><p>A per-seat payout address could send rewards straight to a shared receiver. It needs an enforceable lock or agreed change/exit rules; freely redirectable routing leaves the provider exposed.</p><p>An alternative is EIP-1271 pairing for an NFT-holding vault, if IMD supports it. That changes the custody design. Neither integration is implemented or confirmed here, and its engineering effort is not established.</p></section>
  <section class="panel"><h2>Service evidence and reviews</h2><p>IMD documents public seat and device standing endpoints. A watcher can sample presence and accepting-work status, retain timestamps and device bindings, and mark missing samples unknown. This supports service records and disputes; it is not a trustless input to a contract.</p><p>Owner reviews require accepted terms and pairing, plus a covered arrival during service or at least 24 paired hours. A provider's approval, payment, or successful payout is not required. Eligibility and identities are simulated.</p><p>AI-provider permission, quotas, authentication and incident support must be agreed separately from the VPS. Device misuse and poor work are owner risks even though rewards arrive at the owner's wallet.</p><a class="text-link" href="https://imd.fun/docs/" target="_blank" rel="noopener noreferrer">IMD public API ↗</a></section></div>`;
}
function render() {
  try {
    renderView();
  } catch {
    if (dialog.open) dialog.close();
    app.innerHTML = `<main class="panel"><h1>The local demo could not be displayed.</h1><p>Your saved data has not been erased. Reset the example data to start again.</p>${button('Reset demo', 'reset', '', 'primary')}</main>`;
    app.querySelector('[data-action="reset"]').onclick = () => handle('reset');
  }
}
function renderView() {
  const path = route(),
    section = path.startsWith('agreement') ? 'agreements' : path === 'guide' ? 'guide' : 'hosts',
    titles = {
      hosts: 'Find a host',
      agreements: 'My agreements',
      guide: 'How it works'
    };
  document.title = `Seat Market — ${titles[section]}`;
  app.innerHTML = `<aside class="sidebar"><a class="brand" href="#hosts"><span class="brand-mark" aria-hidden="true">s</span>seat market<span class="brand-period">.</span></a><div class="workspace-label">THE HOSTING COMMONS</div><nav aria-label="Main navigation">${[['hosts', '▦', 'Find a host'], ['agreements', '≡', 'My agreements'], ['guide', '↗', 'How it works']].map(([href, ico, label]) => `<a class="nav-item ${section === href ? 'active' : ''}" ${section === href ? 'aria-current="page"' : ''} href="#${href}"><span>${ico}</span>${label}${href === 'agreements' ? `<small>${state.agreements.length}</small>` : ''}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="mini-orbit">◎</div><strong>Your NFT. Your wallet.</strong><p>Find someone to run the worker.</p>${button('Reset demo', 'reset', '', 'ghost reset-button')}<span class="local-label">LOCAL PROTOTYPE · V0.3</span></div></aside><div class="shell"><header class="topbar"><div class="breadcrumb">Workspace <span>/</span> <strong>${titles[section]}</strong></div><span class="demo-tag">DEMO MODE</span>${button(theme === 'dark' ? '☀ Light' : '☾ Dark', 'theme', `aria-label="Switch to ${theme === 'dark' ? 'light' : 'dark'} mode"`, 'small theme-button')}<label class="identity"><span class="avatar small">${role === 'owner' ? 'O' : 'H'}</span><select id="role" aria-label="Preview as"><option value="owner" ${role === 'owner' ? 'selected' : ''}>Owner preview</option><option value="host" ${role === 'host' ? 'selected' : ''}>Host preview</option></select></label></header>${appearanceBar()}<main>${restoreError ? '<div class="note amber">Saved demo data could not be restored. A fresh local session is shown. Your next change will replace the incompatible saved demo.</div>' : ''}${storageWarning ? '<div class="note amber">Browser storage is unavailable. Changes last for this page session only.</div>' : ''}${section === 'hosts' ? hostsView() : section === 'guide' ? guideView() : path.startsWith('agreement/') ? agreementView(getAgreement()) : agreementsView()}<footer>Built for the identity.md community <span>Local simulation · no wallet, live pairing, or payments</span></footer></main></div>`;
  document.querySelector('#role').onchange = event => {
    role = event.target.value;
    render();
    toast(`Now previewing the ${role}’s actions.`);
  };
  const select = document.querySelector('#runtime-filter');
  if (select) select.onchange = event => {
    filter = event.target.value;
    render();
  };
  const skillSelect = document.querySelector('#skill-filter');
  if (skillSelect) skillSelect.onchange = event => {
    skillFilter = event.target.value;
    render();
  };
  document.querySelectorAll('[data-action]').forEach(b => b.onclick = () => handle(b.dataset.action, b.dataset.id));
}
function offer(id) {
  const h = state.hosts.find(h => h.id === id);
  if (!h) return;
  showDialog(`<h2 id="dialog-title">Propose terms with ${e(h.name)}</h2><p>${e(h.service)}</p><div class="note">${e(machineLabel(h))} · Deposit ${money(h.securityDeposit)} DEMO · Daily minimum ${money(h.dailyMinimum)} DEMO, offset against the provider share within each 24-hour period.</div><form id="proposal-form"><label>LLM option<select name="llm">${h.llmOptions.map(x => '<option>' + e(x) + '</option>').join('')}</select></label><label>Demo NFT number<input name="nft" placeholder="e.g. 2049" inputmode="numeric" pattern="[0-9]{1,6}" required maxlength="6"></label><label>Dedicated demo wallet label<input name="wallet" placeholder="demo-wallet-2049" pattern="[a-zA-Z0-9-]{3,40}" required maxlength="40"></label><label class="checkbox-label"><input name="dedicated" type="checkbox" required> One hosted NFT in this wallet; no other seats or mixed reward sources.</label><label>Owner share (%)<input name="share" type="number" min="1" max="99" step="1" required value="${h.ownerBps / 100}"></label><div class="split-preview" id="split-preview">${h.ownerBps / 100}% owner / ${100 - h.ownerBps / 100}% provider</div><div class="note">Coverage uses reward arrival time, with a proposed 72-hour exit window. The owner receives rewards and must pay the provider share.</div><label class="checkbox-label"><input type="checkbox" required> I understand this creates a local proposal only.</label><p class="form-error" role="alert"></p><button class="button primary full" type="submit">Create demo proposal</button></form>`);
  dialog.querySelector('[name="share"]').oninput = ev => {
    const n = Number(ev.target.value);
    dialog.querySelector('#split-preview').textContent = n >= 1 && n <= 99 ? `${n}% owner / ${100 - n}% provider` : 'Enter an owner share from 1 to 99%.';
  };
  dialog.querySelector('form').onsubmit = ev => {
    ev.preventDefault();
    const data = new FormData(ev.currentTarget);
    try {
      const result = createAgreement(state, {
        hostId: id,
        nft: data.get('nft'),
        wallet: data.get('wallet'),
        llm: data.get('llm'),
        dedicatedWallet: data.get('dedicated') === 'on',
        ownerBps: Number(data.get('share')) * 100
      });
      state = result.state;
      save();
      dialog.close();
      go(`agreement/${result.id}`);
      toast('Proposal created. Each side must approve.');
    } catch (error) {
      formError(error.message);
    }
  };
}
function approve(a) {
  const v = pendingVersion(a);
  if (!v) return;
  showDialog(`<h2 id="dialog-title">Approve v${v.number} as ${role}</h2>${termsRows(a, v)}<div class="note">Approving does not redirect rewards. The owner still receives them; payment and share acknowledgment still require owner cooperation.</div><form><label class="checkbox-label"><input type="checkbox" required> I reviewed this exact version in the ${role} preview.</label><p class="form-error" role="alert"></p><button class="button primary full" type="submit">Simulate ${role} approval</button></form>`);
  const approvingRole = role,
    approvedTermsKey = termsKey(v);
  dialog.querySelector('form').onsubmit = ev => {
    ev.preventDefault();
    dialog.close();
    act(a.id, 'approve', approvingRole, {
      version: v.number,
      termsKey: approvedTermsKey
    });
  };
}
function amend(a) {
  showDialog(`<h2 id="dialog-title">Propose the next version</h2><p>Prior arrivals retain their splits. Future arrivals use the new split only after both sides approve.</p><form><label>New owner share (%)<input name="share" type="number" min="1" max="99" step="1" value="${(pendingVersion(a) || currentVersion(a)).ownerBps / 100}" required></label><p class="form-error" role="alert"></p><button class="button primary full" type="submit">Propose new split</button></form>`);
  dialog.querySelector('form').onsubmit = ev => {
    ev.preventDefault();
    try {
      state = transition(state, a.id, 'amend', role, {
        ownerBps: Number(new FormData(ev.currentTarget).get('share')) * 100
      });
      save();
      dialog.close();
      render();
    } catch (error) {
      formError(error.message);
    }
  };
}
function confirm(title, copy, action) {
  showDialog(`<h2 id="dialog-title">${title}</h2><p>${copy}</p><div class="action-row">${button('Cancel', 'cancel')}${button('Confirm in demo', 'confirm', '', 'primary')}</div>`);
  dialog.querySelector('[data-action="cancel"]').onclick = () => dialog.close();
  dialog.querySelector('[data-action="confirm"]').onclick = () => {
    dialog.close();
    try {
      action();
    } catch (error) {
      toast(error.message);
    }
  };
}
function listHost() {
  showDialog(`<h2 id="dialog-title">Advertise your demo host</h2><p>Create a local provider profile. Nothing is published and no capacity is verified.</p><form><label>Provider name<input name="name" maxlength="40" minlength="3" required placeholder="Your example operator"></label><label>Introduction<textarea name="description" minlength="10" maxlength="500" rows="2" required placeholder="Who you host for and what your service includes"></textarea></label><div class="form-grid"><label>Region<select name="region">${['US East', 'US West', 'EU West', 'Asia Pacific'].map(x => '<option>' + x + '</option>').join('')}</select></label><label>Primary runtime<select name="runtime"><option>Codex</option><option>Claude</option></select></label><label>Machine vCPU<input name="cpu" type="number" min="1" max="256" value="4" required></label><label>Machine RAM (GB)<input name="ram" type="number" min="1" max="2048" value="8" required></label><label>Machine disk (GB)<input name="disk" type="number" min="1" max="16384" value="80" required></label><label>Available seat slots<input name="slots" type="number" min="1" max="20" value="2" required></label><label>Owner share (%)<input name="share" type="number" min="1" max="99" value="70" required></label><label>Required deposit (DEMO)<input name="deposit" type="number" min="0" max="1000000" step="0.01" value="10" required></label><label>Daily minimum (DEMO)<input name="minimum" type="number" min="0" max="1000000" step="0.01" value="2" required></label><label>AI access arrangement<select name="ai"><option>Host supplied</option><option>Owner arranged</option></select></label></div><label>Supported skills (1–8, comma separated)<input name="skills" maxlength="500" value="Websites, Research" required></label><label>LLM options (1–8, comma separated)<input name="llms" maxlength="500" value="Codex · host-selected model, Codex · owner-arranged access" required></label><label>Service, resource allocation & support<textarea name="service" minlength="10" maxlength="500" rows="3" required placeholder="Describe per-seat allocation, model limits, monitoring, support and maintenance"></textarea></label><div class="note">Each 24-hour period charges the greater of its share or elapsed-time minimum, including downtime until exit. Deposit must cover at least one day. Use zero for both to offer pure revenue sharing. Use 2–80 characters per skill or LLM option. Model access and provider permission are advertised, not verified. Never include credentials.</div><p class="form-error" role="alert"></p><button class="button primary full" type="submit">Save local provider profile</button></form>`);
  const runtimeSelect = dialog.querySelector('[name="runtime"]'),
    llmsInput = dialog.querySelector('[name="llms"]');
  let previousRuntime = 'Codex';
  runtimeSelect.onchange = () => {
    const previousDefault = previousRuntime + ' · host-selected model, ' + previousRuntime + ' · owner-arranged access';
    if (llmsInput.value === previousDefault) llmsInput.value = runtimeSelect.value + ' · host-selected model, ' + runtimeSelect.value + ' · owner-arranged access';
    previousRuntime = runtimeSelect.value;
  };
  dialog.querySelector('form').onsubmit = ev => {
    ev.preventDefault();
    const d = new FormData(ev.currentTarget);
    try {
      state = createHost(state, {
        name: d.get('name'),
        description: d.get('description'),
        service: d.get('service'),
        region: d.get('region'),
        runtime: d.get('runtime'),
        slots: Number(d.get('slots')),
        ownerBps: Number(d.get('share')) * 100,
        ai: d.get('ai'),
        machine: {
          cpu: Number(d.get('cpu')),
          ramGb: Number(d.get('ram')),
          diskGb: Number(d.get('disk'))
        },
        skills: d.get('skills').split(',').map(x => x.trim()).filter(Boolean),
        llmOptions: d.get('llms').split(',').map(x => x.trim()).filter(Boolean),
        securityDeposit: minorUnits(d.get('deposit')),
        dailyMinimum: minorUnits(d.get('minimum'))
      });
      save();
      dialog.close();
      filter = 'all';
      skillFilter = 'all';
      render();
      toast('Provider profile saved locally.');
    } catch (error) {
      formError(error.message);
    }
  };
}
function handle(action, id) {
  if(action==='look' && Object.hasOwn(LOOKS,id)) {
    look=id;
    document.documentElement.dataset.look=look;
    document.documentElement.classList.toggle('imd-look',look!=='original');
    try { localStorage.setItem('seat-market.look',look); } catch {}
    const url=new URL(location.href);url.searchParams.set('look',look);history.replaceState(null,'',url);
    render();document.querySelector('[data-look-choice="'+look+'"]')?.focus();return;
  }
  if (action === 'theme') {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('seat-market.theme', theme);
    } catch {}
    const url=new URL(location.href);if(url.searchParams.has('theme')){url.searchParams.set('theme',theme);history.replaceState(null,'',url);}
    render();
    return;
  }
  const a = state.agreements.find(x => x.id === id);
  if (action === 'offer') return offer(id);
  if (action === 'list') return listHost();
  if (action === 'profile') return hostProfile(id);
  if (action === 'reviews') return hostReviews(id);
  if (action === 'reset') return confirm('Reset the local demo?', 'This clears only Seat Market’s example offers, agreements, and credits in this browser.', () => {
    state = initialState();
    restoreError = false;
    save();
    go('hosts');
    render();
    toast('Local demo reset.');
  });
  if (action === 'example') return confirm('Load the lifecycle example?', 'This replaces local demo data with one 70/30 agreement, 10 DEMO collateral, 24 paired hours, and a 100 DEMO owner-wallet arrival awaiting owner acknowledgment or payment.', () => {
    state = demoScenario();
    save();
    go('agreement/SM-001');
  });
  if (!a) return;
  if (action === 'review') return reviewForm(a);
  if (action === 'deposit') return depositForm(a);
  if (['draw-reserve', 'refund'].includes(action)) return act(id, action, role);
  if (action === 'recovery') return confirm('Request direct wallet revocation?', 'This separate wallet-signed route remains unverified. The request is local only and does not revoke the device. Transfer-based revocation is a different, code-supported path.', () => act(id, 'recovery', role));
  if (action === 'approve') return approve(a);
  if (action === 'amend') return amend(a);
  if (action === 'end') return confirm(currentVersion(a) ? 'End future participation?' : 'Close this proposal?', currentVersion(a) ? 'The final split covers matching arrivals for 72 more hours. Hosting-minimum accrual ends now; the host must stop service. Funded claims remain available. ' + (a.pairing === 'paired' ? 'The device remains paired until unlink or transfer.' : 'No device is currently paired.') : 'Neither party accepted a complete agreement. Closing this proposal starts no service charge or arrival window.', () => act(id, 'end', role));
  if (action === 'transfer') return confirm('Move NFT to revoke (demo)?', 'This simulates work stopping after transfer, followed by a pending network disconnect. The developer reports roughly 30 minutes after sale; the demo requires a separate disconnect confirmation. This also ends the demo agreement; a real escrow exit needs its own transaction. No NFT moves. Agent-ID continuity and moving back still need a live test. The old wallet remains the only covered destination during the exit window.', () => act(id, 'transfer', role));
  if (action === 'unlink') return confirm('Simulate host unlink?', 'The host can unlink at any time. This also ends participation and starts the agreed arrival window if the agreement is still open.', () => act(id, 'unlink', role));
  if (action === 'pay') return paymentForm(a);
  if (action === 'attest') return attestForm(a);
  if (action === 'advance-disconnect') return act(id, 'advance', 'demo', {
    ms: TRANSFER_DELAY
  });
  if (action === 'advance') return act(id, 'advance', 'demo', {
    ms: 24 * HOUR
  });
  if (['arrive', 'other-arrival'].includes(action)) return act(id, 'arrive', 'demo', {
    arrivalId: 'demo-arrival-' + (state.seq + 1),
    amount: 10000,
    payer: action === 'arrive' ? PAYER : 'Unrelated payer',
    wallet: a.wallet
  });
  act(id, action, ['withdraw', 'discard'].includes(action) ? role : 'demo');
}
window.addEventListener('hashchange', () => {
  render();
  document.querySelector('main h1')?.setAttribute('tabindex', '-1');
  document.querySelector('main h1')?.focus({
    preventScroll: true
  });
  window.scrollTo(0, 0);
});
render();
const context = document.modelContext;
if (context?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), {
    once: true
  });
  const tools = [{
    name: 'seat_market_snapshot',
    title: 'Read Seat Market demo',
    description: 'Read fictional hosts and local demo agreement summaries. No live service data.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      untrustedContentHint: true
    },
    execute: () => ({
      mode: 'local-demo',
      hosts: state.hosts.map(h => ({
        id: h.id,
        name: h.name,
        ownerPercent: h.ownerBps / 100
      })),
      agreements: state.agreements.map(a => ({
        id: a.id,
        nft: a.nft,
        status: agreementStatus(a),
        routing: a.routing,
        pairing: a.pairing
      }))
    })
  }, {
    name: 'create_demo_agreement',
    title: 'Create local demo proposal',
    description: 'Create a browser-local simulated proposal and open its agreement page. Does not sign, pair, pay, or contact anyone.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet: {
          type: 'string'
        },
        dedicatedWallet: {
          type: 'boolean',
          const: true
        },
        hostId: {
          type: 'string'
        },
        nft: {
          type: 'string'
        },
        ownerPercent: {
          type: 'integer',
          minimum: 1,
          maximum: 99
        }
      },
      required: ['hostId', 'nft', 'ownerPercent', 'wallet', 'dedicatedWallet'],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      untrustedContentHint: false
    },
    execute: input => {
      if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['hostId', 'nft', 'ownerPercent', 'wallet', 'dedicatedWallet'].includes(k)) || !Number.isInteger(input.ownerPercent)) throw Error('Invalid demo proposal.');
      const id = proposals(input.hostId, input.nft, input.ownerPercent, input.wallet, input.dedicatedWallet);
      render();
      return {
        id,
        mode: 'local-demo',
        status: 'Awaiting approval'
      };
    }
  }];
  for (const tool of tools) {
    try {
      Promise.resolve(context.registerTool(tool, {
        signal: lifecycle.signal
      })).catch(() => {});
    } catch {}
  }
}
