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

export function setupUI({ getState, getWallet, api, toast, confirmDialog, refresh }) {
  const panel = document.getElementById('setupRoom');
  let pending = false, lastState = null, receivedAt = Date.now(), reminder = '', lastHeartbeat = 0, lastActionNotice = '';
  const now = () => (lastState?.now || Date.now()) + Date.now() - receivedAt;
  const mine = () => lastState?.setup?.account?.toLowerCase() === getWallet().address?.toLowerCase();
  const command = async (action, body = {}) => {
    if (pending) return;
    pending = true;
    try { await api(`/api/setup/${action}`, { ...body, account: getWallet().address }); await refresh(); }
    catch (e) { toast(e.message, true); }
    finally { pending = false; render(getState()); }
  };
  async function join() {
    if (pending) return;
    const w = getWallet(), s = getState();
    if (!w.address || w.chainId !== s.config.chainId) return toast('Connect your wallet on the agreed chain first', true);
    pending = true;
    try {
      const c = await api('/api/setup/challenge', { account: w.address });
      if (!await confirmDialog(`<h2>Join the setup room</h2><p>This message signs you in. It costs no gas and cannot move your NFT or approve pairing.</p><pre class="offer">${esc(c.message)}</pre>`)) return;
      const data = '0x' + [...new TextEncoder().encode(c.message)].map((v) => v.toString(16).padStart(2, '0')).join('');
      const signature = await w.eth.request({ method: 'personal_sign', params: [data, w.address] });
      await api('/api/setup/join', { nonce: c.nonce, signature });
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
    if (Date.now() - receivedAt > 45_000) { panel.querySelectorAll('button').forEach((b) => { b.disabled = true; }); panel.querySelectorAll('.presence p').forEach((p) => { p.textContent = 'Refresh needed · availability unknown'; }); }
    const p = s.pairing, room = s.setup?.room;
    const target = document.getElementById('pairingCountdown');
    if (target && p.artifact) {
      const code = Number(p.codeExpiresAt), sig = p.artifact.message.expiresAt * 1000;
      const left = Math.min(code, sig) - now();
      target.textContent = p.completed || ['register', 'active', 'exit'].includes(s.derived.step) ? 'Pairing complete' : left <= 0 ? 'Attempt expired — confirm readiness to try again' : `Code ${remaining(code, now())} · approval ${remaining(sig, now())}`;
      target.classList.toggle('urgent', left < 60_000 && !p.completed);
      if (left < 60_000) document.querySelectorAll('[data-action="approvePairing"]').forEach((b) => { b.disabled = true; });
      if (left <= 0) document.querySelectorAll('[data-action="pairing-complete"]').forEach((b) => { b.disabled = true; });
    }
    const reminderEl = document.getElementById('setupReminder');
    if (reminderEl && room?.schedule.at && (!room.attempt || room.attempt.phase === 'expired') && !['register', 'active', 'exit'].includes(s.derived.step)) {
      const at = room.schedule.at, diff = at - now();
      const text = diff > 10 * 60000 ? '' : diff > 0 ? `Your setup starts in ${Math.ceil(diff / 60000)} minutes. Open your wallet when ready.` : diff > -15 * 60000 ? 'It is time for your setup. Both people can confirm readiness below.' : 'This appointment has passed. Connect now or agree a new time.';
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
    const setup = s.setup || {}, r = setup.room, w = getWallet(), joined = mine() && !!r;
    const enabled = joined && w.chainId === s.config.chainId && !pending;
    const active = r?.attempt && r.attempt.phase !== 'expired';
    const finished = s.pairing?.completed || ['register', 'active', 'exit'].includes(s.derived.step);
    const title = finished ? (s.vault.ended ? 'Your agreement has ended' : 'Your NFT is connected') : 'Connect your NFT';
    const role = setup.role;
    const approved = s.pairing?.artifact?.digest?.toLowerCase() === s.vault.approvedDigest?.toLowerCase();
    const status = (who) => finished ? 'Setup complete' : active && r?.parties[who]?.online
      ? (who === 'owner' ? approved ? 'Approval confirmed' : 'Approval needed' : approved ? 'Completing connection' : 'Waiting for approval')
      : r?.parties[who]?.ready ? 'Ready' : r?.parties[who]?.online ? 'Here · not ready yet' : 'Not here yet';
    const at = r?.schedule.at;
    const confirmed = r?.schedule.accepted.owner && r?.schedule.accepted.host;
    const live = s.vault.held && !s.vault.ended && !s.error;
    const canReady = enabled && live && !active && !finished && (!at || at <= now() + 10 * 60000) && (!r.schedule.version || r.schedule.accepted[role]);
    const button = (key, label, okay = enabled, primary = false) => `<button class="button${primary ? ' primary' : ''}" data-setup="${key}" ${okay ? '' : 'disabled'}>${label}</button>`;
    panel.innerHTML = `<div class="room-heading"><div><p class="eyebrow">OWNER + HOST / SETUP ROOM</p><h1>${title}</h1><p class="room-subtitle">${finished ? 'Your next actions are below.' : 'Get ready first. Start the clock together.'}</p></div><span class="room-badge">${finished ? 'COMPLETE' : active ? 'PAIRING' : r?.bothReady ? 'READY TO CONNECT' : 'GETTING READY'}</span></div>
      <div class="presence-grid">${['owner', 'host'].map((who) => `<div class="presence ${r?.parties[who]?.ready ? 'is-ready' : ''}"><span class="presence-dot"></span><div><b>${who === 'owner' ? 'NFT owner' : 'Host'}</b><p>${esc(status(who))}</p></div></div>`).join('')}</div>
      ${setup.error ? `<p class="room-warning">Setup needs attention: ${esc(setup.error)}. Rejoin if your session expired.</p>` : ''}
      ${!joined ? `<p>Join with your wallet to coordinate. This sign-in costs no gas.</p>${button('join', 'Join setup room', !!w.address && w.chainId === s.config.chainId && !pending, true)}` : `
      ${at ? `<div class="appointment"><b>${esc(fmt(at))}</b><span>${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)} · ${confirmed ? 'confirmed by both people' : 'awaiting confirmation'}</span>${!r.schedule.accepted[role] ? button('accept', 'Confirm this time') : ''}${button('calendar', 'Add to calendar', true)}</div>` : '<p class="room-subtitle">Connect now, or agree a time that works for both of you.</p>'}
      <p id="setupReminder" class="room-reminder" role="status" aria-live="polite"></p>
      ${!finished && !active ? `<div class="room-buttons">${button('ready', r?.parties[role]?.ready ? 'I need more time' : role === 'owner' ? 'Connect my NFT' : 'I’m ready', canReady, true)}${button('schedule', 'Schedule a time', enabled)}${at || (r.schedule.version && !r.schedule.accepted[role]) ? button('now', 'Connect now', enabled) : ''}${button('invite', 'Copy room link', true)}</div>` : ''}
      ${active && !finished ? `<p class="room-subtitle">${role === 'owner' ? approved ? 'Your approval is confirmed. The host is completing the connection.' : 'Review the exact pairing and approve it in your wallet below.' : approved ? 'The owner approved. Complete this connection below, or let automatic setup finish.' : 'Waiting for the owner’s approval to confirm on chain.'}</p>` : ''}
      ${!live && !finished ? '<p class="room-subtitle">Create and deposit your NFT first using the steps below. No pairing timer is running.</p>' : ''}
      ${role === 'host' && !finished ? `<div class="auto-setup">${button(setup.armedUntil > now() ? 'disarm' : 'arm', setup.armedUntil > now() ? 'Stop automatic setup' : 'Accept setup requests · 30 min', enabled && s.config.operatorOnServer && (setup.armedUntil > now() || !active))}<p>${setup.armedUntil > now() ? 'This local console will handle one pairing attempt when the owner is ready. Keep the local server running.' : 'Optional: your local operator key requests the code, waits for the exact owner approval and completes one pairing. The shared service never gets your key.'}</p></div>` : ''}
      <div class="room-session"><span>Signed in as ${esc(role)}${setup.armedUntil > now() ? ' · automatic setup enabled' : ''}</span>${button('leave', 'Leave room', enabled)}</div>`}
      <div class="pairing-clock"><strong id="pairingCountdown">${active && !s.pairing?.artifact ? 'Preparing a fresh pairing code…' : 'No pairing timer running'}</strong><span>${finished ? '' : active ? 'Only a confirmed approval counts. The console checks the exact signature before completing.' : 'Keep this page open for reminders, or add the appointment to your calendar. No sound.'}</span></div>`;
    const handlers = {
      join, schedule, calendar: downloadCalendar,
      accept: () => command('accept', { version: r.schedule.version }),
      now: () => command('schedule', { at: null }),
      ready: () => command('ready', { ready: !r.parties[role].ready, version: r.schedule.version }),
      arm: async () => { if (confirm('Allow this local console to start and complete one pairing for this vault when the owner is ready, for up to 30 minutes? The owner must still approve the exact digest on chain.')) await command('arm'); },
      disarm: () => command('disarm'), leave: () => command('leave'),
      invite: async () => { try { await navigator.clipboard.writeText(`${location.origin}/#vault=${s.vault.address}`); toast('Room link copied. Both consoles must use the same setup service.'); } catch { toast('Copy the vault address into the other console', true); } },
    };
    panel.querySelectorAll('[data-setup]').forEach((b) => { b.onclick = handlers[b.dataset.setup]; });
    document.querySelectorAll('[data-action="pairing-start"]').forEach((b) => { b.disabled = !enabled || role !== 'host' || !r?.bothReady || active || !!setup.error; });
    if (joined && active && s.pairing?.artifact && !finished) {
      const notice = `${s.vault.address}:${s.pairing.artifact.digest}:${approved}`;
      if (lastActionNotice !== notice) {
        lastActionNotice = notice;
        if (role === 'owner' && !approved) toast('Your host is ready. Review and approve the pairing in your wallet.');
        if (role === 'host' && approved) toast(setup.armedUntil > now() ? 'Approval confirmed. Automatic setup is completing the connection.' : 'The owner approved. Complete the pairing now.');
      }
    }
    tick();
  }
  async function heartbeat(active = document.visibilityState === 'visible') {
    const s = getState(); if (!s?.setup?.account || !mine()) return;
    if (active && Date.now() - lastHeartbeat < 10_000) return;
    lastHeartbeat = Date.now();
    try { await api('/api/setup/heartbeat', { active, account: getWallet().address }); } catch { /* next state read shows service errors */ }
  }
  document.addEventListener('visibilitychange', () => { lastHeartbeat = 0; heartbeat(); });
  window.addEventListener('pagehide', () => {
    if (mine()) fetch('/api/setup/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: false, account: getWallet().address }), keepalive: true }).catch(() => {});
  });
  setInterval(() => { tick(); heartbeat(); }, 1000);
  return { render, disconnected() { panel.querySelectorAll('button').forEach((b) => { b.disabled = true; }); panel.querySelectorAll('.presence p').forEach((p) => { p.textContent = 'Connection lost · availability unknown'; }); } };
}
