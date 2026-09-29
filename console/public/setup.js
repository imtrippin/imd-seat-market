const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
export function remaining(deadline, now) {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function calendarEvent({ at, vault, chainId, version }) {
  const stamp = (n) => new Date(n).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z/, 'Z');
  if (!Number.isSafeInteger(at) || !/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new Error('Invalid appointment');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Seat Console//Setup//EN', 'BEGIN:VEVENT',
    `UID:${chainId}-${vault}-${version}@seat-console`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(at)}`, `DTEND:${stamp(at + 15 * 60000)}`,
    'SUMMARY:Connect your NFT with your host', 'DESCRIPTION:Open your local Seat console and join the agreed setup room. No pairing code has been generated yet.',
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', 'DESCRIPTION:NFT setup begins in ten minutes', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

/// Room readiness gates the host's start button only while signed into a room (also when its service is down);
/// in manual mode the action list's own state stands. Returns null for "leave the button alone".
export function pairingStartDisabled({ roomMode, enabled, role, bothReady, active, error }) {
  if (!roomMode) return null;
  return !enabled || role !== 'host' || !bothReady || active || !!error;
}

const lower = (s) => String(s || '').toLowerCase();
export function setupUI({ getState, getWallet, isBusy, connectWallet, runAction, api, toast, confirmDialog, refresh }) {
  const panel = document.getElementById('setupRoom');
  let pending = false, lastState = null, receivedAt = Date.now(), reminder = '', lastHeartbeat = 0;
  const now = () => (lastState?.now || Date.now()) + Date.now() - receivedAt;
  const mine = () => !!getWallet().address && lower(lastState?.setup?.account) === lower(getWallet().address);
  const walletRole = (s, w) => lower(w.address) === lower(s.vault.owner) ? 'owner'
    : [s.vault.provider, s.vault.operator].some((a) => lower(a) === lower(w.address)) ? 'host' : null;
  const command = async (action, body = {}) => {
    if (pending || isBusy()) return;
    pending = true; render(getState());
    try { await api(`/api/setup/${action}`, { ...body, account: getWallet().address }); await refresh(); }
    catch (e) { toast(e.message, true); }
    finally { pending = false; render(getState()); }
  };

  // Authenticate when needed, then carry out the selected connection intent. The owner still approves pairing on chain.
  async function begin(action = null) {
    if (pending || isBusy()) return;
    pending = true; render(getState());
    try {
      if (!getWallet().address) await connectWallet();
      const w = getWallet(), s = getState(), vault = s.vault.address;
      if (!w.address || w.chainId !== s.config.chainId) throw new Error('Connect your wallet on the agreed chain first');
      const account = w.address, chain = w.chainId, role = walletRole(s, w);
      if (!role || (action === 'arm' && role !== 'host') || (action === 'ready' && role !== 'owner')) throw new Error('Connect the wallet for this role');
      const unchanged = () => getState().vault?.address === vault && getWallet().address === account && getWallet().chainId === chain;
      if (!mine() || !s.setup?.room) {
        const c = await api('/api/setup/challenge', { account });
        const next = action === 'arm' ? 'Then your local host will accept one connection for this NFT for up to 30 minutes.'
          : action === 'ready' ? 'Then we will ask your host to connect this NFT. You approve the connection separately on chain.' : '';
        if (!await confirmDialog(`<h2>Sign in for this agreement</h2><p>This message costs no gas and cannot move your NFT or approve pairing. ${next}</p><details><summary>Show sign-in message</summary><pre class="offer">${esc(c.message)}</pre></details>`, 'Sign in wallet')) return;
        if (!unchanged()) throw new Error('The wallet or agreement changed; start again');
        const data = '0x' + [...new TextEncoder().encode(c.message)].map((v) => v.toString(16).padStart(2, '0')).join('');
        const signature = await w.eth.request({ method: 'personal_sign', params: [data, account] });
        if (!unchanged()) throw new Error('The wallet or agreement changed; start again');
        await api('/api/setup/join', { nonce: c.nonce, signature });
        await refresh();
      }
      if (!unchanged()) throw new Error('The wallet or agreement changed; start again');
      if (action === 'arm') await api('/api/setup/arm', { account });
      if (action === 'ready') await api('/api/setup/ready', { account, ready: true, version: getState().setup.room.schedule.version });
      await refresh();
    } catch (e) { toast(e.message, true); }
    finally { pending = false; render(getState()); }
  }
  function schedule() {
    const d = document.getElementById('dialog');
    document.getElementById('dialogContent').innerHTML = `<h2>Choose a setup time</h2><p>Shown in ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}. The other person confirms it.</p><form id="scheduleForm" class="form"><label>Date and time<input type="datetime-local" name="at" required></label><div class="room-buttons"><button class="button primary">Propose time</button><button type="button" class="button" id="closeSchedule">Cancel</button></div></form>`;
    d.showModal(); document.getElementById('closeSchedule').onclick = () => d.close();
    document.getElementById('scheduleForm').onsubmit = (ev) => {
      ev.preventDefault(); const at = new Date(new FormData(ev.target).get('at')).getTime(); d.close(); command('schedule', { at });
    };
  }
  function downloadCalendar() {
    const s = getState(), r = s.setup.room;
    const blob = new Blob([calendarEvent({ at: r.schedule.at, version: r.schedule.version, vault: s.vault.address, chainId: s.config.chainId })], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'nft-setup.ics'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function tick() {
    const s = lastState;
    if (!s?.vault) return;
    if (Date.now() - receivedAt > 45_000) disconnected();
    const p = s.pairing, room = s.setup?.room, target = document.getElementById('pairingCountdown');
    if (target && p.artifact) {
      const code = Number(p.codeExpiresAt), sig = p.artifact.message.expiresAt * 1000, left = Math.min(code, sig) - now();
      target.textContent = left <= 0 ? 'This code expired. Start a new attempt when both people are ready.' : `Time remaining ${remaining(Math.min(code, sig), now())}`;
      target.classList.toggle('urgent', left < 60_000);
      if (left < 60_000) document.querySelectorAll('[data-action="approvePairing"]').forEach((b) => { b.disabled = true; });
      if (left <= 0) document.querySelectorAll('[data-action="pairing-complete"]').forEach((b) => { b.disabled = true; });
    }
    const reminderEl = document.getElementById('setupReminder');
    if (reminderEl && room?.schedule.at && (!room.attempt || room.attempt.phase === 'expired') && s.derived.step === 'pair') {
      const diff = room.schedule.at - now();
      const text = diff > 10 * 60000 ? '' : diff > 0 ? `Setup starts in ${Math.ceil(diff / 60000)} minutes.` : diff > -15 * 60000 ? 'It is time for your setup.' : 'This appointment has passed. Choose another time or connect now.';
      reminderEl.textContent = text;
      if (text && reminder !== `${room.schedule.version}:${diff > 0 ? 'soon' : 'due'}`) {
        reminder = `${room.schedule.version}:${diff > 0 ? 'soon' : 'due'}`; toast(text);
      }
    }
  }
  function render(s) {
    if (!s) return;
    if (s !== lastState) { lastState = s; receivedAt = Date.now(); }
    panel.classList.toggle('hidden', !s.vault);
    if (!s.vault) return;
    const optionsOpen = panel.querySelector('#setupOptions')?.open || false;
    const setup = s.setup || {}, r = setup.room, w = getWallet(), v = s.vault;
    const role = walletRole(s, w), joined = mine() && !!r;
    const blocked = pending || isBusy() || !!s.error || w.chainId !== s.config.chainId;
    const enabled = joined && !blocked, active = !!r?.attempt && r.attempt.phase !== 'expired', armed = setup.armedUntil > now();
    const paired = s.pairing?.completed || ['register', 'active'].includes(s.derived.step);
    const finished = s.derived.step === 'active' || s.derived.step === 'exit';
    const approved = !!s.pairing?.artifact && lower(s.pairing.artifact.digest) === lower(v.approvedDigest) && v.approvedUntil * 1000 > now();
    const offered = s.pairing?.artifact && Math.min(s.pairing.codeExpiresAt, s.pairing.artifact.message.expiresAt * 1000) > now();
    const live = v.held && !v.ended && !s.error, at = r?.schedule.at;
    const scheduleOkay = !r || ((!at || at <= now() + 10 * 60000) && (!r.schedule.version || r.schedule.accepted[role]));
    const button = (key, label, okay = enabled, primary = false) => `<button class="button${primary ? ' primary' : ''}" data-setup="${key}" ${okay ? '' : 'disabled'}>${label}</button>`;
    const actionButton = (id, label) => `<button class="button primary" data-action="${id}" ${blocked ? 'disabled' : ''}>${esc(label)}</button>`;
    let title = role === 'host' ? 'Host this NFT' : 'Connect your NFT';
    let text = role === 'host' ? 'Enable your prepared worker. The owner can connect without you staying at the screen.' : 'Your host handles the setup. You review and approve the connection in your wallet.';
    let status = 'READY TO SET UP', primary = '';
    if (v.ended) { title = 'Agreement ended'; text = 'Your rewards remain available under the agreed split.'; status = 'ENDED'; }
    else if (s.derived.step === 'active') { title = 'NFT connected'; text = 'IMD reports the worker paired and an agent bound to this NFT.'; status = 'CONNECTED'; }
    else if (paired) {
      title = 'Worker connected'; text = 'Pairing is complete. Finish agent registration before hosting can begin.'; status = 'FINISH SETUP';
      if (role === 'owner') primary = s.registration?.agentId ? actionButton('bind', 'Finish setup') : actionButton('finish-registration', 'Finish setup');
    } else if (!v.held) {
      title = 'Prepare your NFT'; text = 'Place this NFT in its agreed vault before connecting the host.';
      const next = s.derived.owner.find((a) => !a.passive && !a.secondary);
      if (role === 'owner' && next) primary = actionButton(next.needs?.[0] || next.id, next.label);
    } else if (approved && offered) {
      title = 'Connecting your NFT'; text = 'Your approval is confirmed. Waiting for the host to finish.'; status = 'CONNECTING';
    } else if (s.pairing?.pendingHashes?.length) {
      title = 'Waiting for confirmation'; text = 'Your approval has been sent. Keep this page open while it confirms.'; status = 'CONFIRMING';
    } else if (offered) {
      title = role === 'host' ? 'Waiting for the owner' : 'Approve your connection';
      text = role === 'host' ? 'The owner must approve this connection on chain before the timer ends.' : 'Approve this exact connection on chain. Your host completes the connection after confirmation.';
      status = 'APPROVAL NEEDED';
      if (role === 'owner') primary = actionButton('approvePairing', 'Approve connection');
    } else if (active) { title = 'Preparing the connection'; text = 'Your host is requesting a fresh pairing code.'; status = 'PREPARING'; }
    else if (role === 'host' && armed) { title = 'Ready for your NFT'; text = 'The owner can connect now. Keep the local host service running; this browser can close.'; status = 'ACCEPTING'; }
    else if (role === 'owner' && r?.parties.owner.ready) { title = 'Waiting for your host'; text = 'Your request is ready. The pairing timer starts only when your host is ready too.'; status = 'WAITING'; }
    else if (live && role) {
      const canBegin = !blocked && scheduleOkay && !(setup.error && setup.account);
      primary = role === 'host' ? button('arm', 'Accept connections', canBegin && s.config.operatorOnServer, true) : button('connect', 'Connect my NFT', canBegin, true);
    }
    if (!w.address) primary = button('wallet', 'Connect wallet', !pending && !isBusy(), true);
    else if (w.chainId !== s.config.chainId) text = `Switch your wallet to chain ${s.config.chainId} using the button above.`;
    else if (!role) text = 'Connect the owner or host wallet for this agreement.';
    const withdrawal = role === 'owner' && s.derived.owner.some((a) => a.id === 'withdraw');
    const claim = role && (role === 'owner' ? s.derived.owner : s.derived.host).some((a) => a.id === 'claim');
    panel.innerHTML = `<div class="room-heading"><div><p class="eyebrow">ONE NFT / ONE HOST</p><h1>${title}</h1><p class="room-subtitle" id="connectionStatus" role="status">${text}</p></div><span class="room-badge">${status}</span></div>
      <div class="agreement-summary"><span>NFT <b>#${esc(v.tokenId)}</b></span><span>Owner keeps <b>${(10000 - v.providerBps) / 100}%</b></span><span>Host receives <b>${v.providerBps / 100}%</b></span><span>No daily fee</span></div>
      ${setup.error ? `<p class="room-warning">Setup paused: ${esc(setup.error)}. Use Other options to sign in again.</p>` : ''}
      <div class="connection-primary">${primary}${role === 'host' && armed ? button('disarm', 'Stop accepting', !pending && !isBusy()) : ''}${role === 'owner' && enabled && r.parties.owner.ready && !active ? button('cancel', 'Cancel request') : ''}</div>
      ${role === 'host' && live && !paired ? `<p class="connection-note">One connection for this NFT, for up to 30 minutes. ${s.config.operatorOnServer ? 'Your local operator key stays on this host.' : 'Configure the agreed local operator key to enable automatic connections, or use manual controls.'}</p>` : ''}
      ${!paired && !v.ended && s.pairing?.artifact ? '<div class="pairing-clock"><strong id="pairingCountdown"></strong><span>Your approval transaction must confirm before this timer ends.</span></div>' : ''}
      ${r && !active && !offered && !paired && !v.ended ? `<p class="connection-presence">Host: ${r.parties.host.ready ? 'ready' : r.parties.host.online ? 'online' : 'not ready yet'} · Owner: ${r.parties.owner.ready ? 'ready' : r.parties.owner.online ? 'online' : 'not here yet'}</p>` : ''}
      <p id="setupReminder" class="room-reminder" role="status"></p>
      <details id="setupOptions" ${optionsOpen ? 'open' : ''}><summary>Other options</summary><div class="setup-options-content">
      ${!joined ? `${button('join', 'Sign in to coordinate', !!role && !blocked)}<p class="connection-note">Optional sign-in for scheduling or manual coordination.</p>` : `
        ${at ? `<div class="appointment"><b>${esc(fmt(at))}</b><span>${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)} · ${r.schedule.accepted.owner && r.schedule.accepted.host ? 'confirmed by both people' : 'awaiting confirmation'}</span>${!r.schedule.accepted[role] ? button('accept', 'Confirm this time') : ''}${button('calendar', 'Add to calendar', true)}</div>` : ''}
        ${!paired && !active && !finished ? `<div class="room-buttons">${button('schedule', 'Schedule a time')}${at || r.schedule.version ? button('now', 'Connect now') : ''}${role === 'host' && !armed ? button('ready', r.parties.host.ready ? 'Not ready' : 'Ready for manual pairing') : ''}</div>` : ''}
        <div class="room-buttons">${button('invite', 'Copy setup link', true)}${button('leave', 'Sign out')}</div>`}
        <p class="connection-note">Manual pairing and full transaction details are below.</p>
      </div></details>
      ${(withdrawal || claim) ? `<div class="connection-exit">${claim ? actionButton('claim', 'Claim rewards') : ''}${withdrawal ? `<button class="link" data-action="withdraw" ${blocked ? 'disabled' : ''}>Take my NFT back</button>` : ''}</div>` : ''}`;
    const handlers = {
      wallet: connectWallet, join: () => begin(), connect: () => begin('ready'), arm: () => begin('arm'),
      disarm: () => command('disarm'), cancel: () => command('ready', { ready: false, version: r.schedule.version }),
      schedule, calendar: downloadCalendar, accept: () => command('accept', { version: r.schedule.version }),
      now: () => command('schedule', { at: null }), ready: () => command('ready', { ready: !r.parties[role].ready, version: r.schedule.version }),
      leave: () => command('leave'),
      invite: async () => { try { await navigator.clipboard.writeText(`${location.origin}/#vault=${v.address}`); toast('Setup link copied. Both consoles must use the same setup service.'); } catch { toast('Copy the vault address into the other console', true); } },
    };
    panel.querySelectorAll('[data-setup]').forEach((b) => { b.onclick = () => Promise.resolve().then(handlers[b.dataset.setup]).catch((e) => toast(e.message, true)); });
    panel.querySelectorAll('[data-action]').forEach((b) => { b.onclick = () => runAction(b.dataset.action); });
    const startDisabled = pairingStartDisabled({ roomMode: !!setup.account, enabled, role: setup.role, bothReady: !!r?.bothReady, active, error: setup.error });
    if (startDisabled !== null) document.querySelectorAll('[data-action="pairing-start"]').forEach((b) => { b.disabled ||= startDisabled; });
    tick();
  }
  async function heartbeat(active = document.visibilityState === 'visible') {
    const s = getState(); if (!s?.setup?.account || !mine()) return;
    if (active && Date.now() - lastHeartbeat < 10_000) return;
    lastHeartbeat = Date.now();
    try { await api('/api/setup/heartbeat', { active, account: getWallet().address }); } catch { /* state refresh shows the service error */ }
  }
  function disconnected() {
    panel.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const status = document.getElementById('connectionStatus');
    if (status) status.textContent = 'Connection lost. Refresh before continuing.';
  }
  document.addEventListener('visibilitychange', () => { lastHeartbeat = 0; heartbeat(); });
  window.addEventListener('pagehide', () => {
    if (mine()) fetch('/api/setup/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: false, account: getWallet().address }), keepalive: true }).catch(() => {});
  });
  setInterval(() => { tick(); heartbeat(); }, 1000);
  return { render, disconnected };
}
