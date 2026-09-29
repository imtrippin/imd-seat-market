// Seat console page: shows the state the loopback server derives, and asks the connected wallet to sign the calls
// it prepares. No library, no third-party script; every transaction's target and calldata are shown before signing.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const lower = (a) => String(a || '').toLowerCase();
import { setupUI } from './setup.js';

let state = null;
let wallet = { eth: null, address: null, chainId: null };
let busy = false;
const setupRoom = setupUI({ getState: () => state, getWallet: () => wallet, api, toast, confirmDialog, refresh: refreshState });

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'visible' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ''; }, isError ? 9000 : 4000);
}

// ---------------------------------------------------------------- wallet

async function connect() {
  const eth = window.ethereum;
  if (!eth) { toast('No wallet found. Enable Rabby or MetaMask for this page.', true); return; }
  wallet.eth = eth;
  const accounts = await eth.request({ method: 'eth_requestAccounts' });
  wallet.address = accounts[0] || null;
  wallet.chainId = parseInt(await eth.request({ method: 'eth_chainId' }), 16);
  eth.on?.('accountsChanged', async (a) => { await api('/api/setup/leave', {}).catch(() => {}); wallet.address = a[0] || null; await refreshState(); });
  eth.on?.('chainChanged', async (c) => { await api('/api/setup/leave', {}).catch(() => {}); wallet.chainId = parseInt(c, 16); await refreshState(); });
  render();
}

async function switchChain() {
  const id = '0x' + state.config.chainId.toString(16);
  try { await wallet.eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: id }] }); } catch (e) { toast(`Could not switch: ${e.message}`, true); }
}

function role() {
  if (!wallet.address) return 'none';
  const v = state?.vault;
  const a = lower(wallet.address);
  if (v) {
    if (a === lower(v.owner)) return 'owner';
    if (a === lower(v.provider)) return 'host';
    if (a === lower(v.operator)) return 'operator';
    return 'viewer';
  }
  if (state?.hostingOffer && a === lower(state.hostingOffer.provider)) return 'host';
  return 'undecided';
}

async function sendTx(action, params = {}) {
  if (busy) return;
  if (!wallet.address) { toast('Connect the wallet first.', true); return; }
  if (wallet.chainId !== state.config.chainId) { toast(`Wallet is on chain ${wallet.chainId}; switch to ${state.config.chainId}.`, true); return; }
  busy = true; render();
  try {
    const built = await api('/api/tx/build', { action, params });
    const from = wallet.address;
    const ok = await confirmDialog(`<h2>${esc(action)}</h2><p>From <b>${esc(from)}</b><br>To <b>${esc(built.to)}</b></p><p class="offer">${esc(built.data)}</p><p>Your wallet will show the same target and data. Nothing is sent by this page except that request.</p>`);
    if (!ok) return;
    const current = await api('/api/tx/build', { action, params });
    if (current.to !== built.to || current.data !== built.data || wallet.address !== from || wallet.chainId !== state.config.chainId) throw new Error('The action or wallet changed; review it again');
    const hash = await wallet.eth.request({ method: 'eth_sendTransaction', params: [{ from, to: built.to, data: built.data, value: '0x0' }] });
    if (action === 'approvePairing' && state.setup?.room?.attempt) {
      try { await api('/api/setup/pending', { hash, attemptId: state.setup.room.attempt.id }); }
      catch { toast(`Approval sent: ${hash}. Setup sync failed; check this transaction before retrying.`, true); }
    }
    state = await api('/api/tx/sent', { action, hash, from });
    toast(`${action} sent: ${short(hash)}`);
  } catch (e) { toast(e.message, true); }
  finally { busy = false; render(); }
}

function confirmDialog(html) {
  return new Promise((resolve) => {
    const d = $('dialog');
    $('dialogContent').innerHTML = html + '<div class="row" style="display:flex;gap:10px;margin-top:16px"><button class="button primary" id="okBtn">Sign in wallet</button><button class="button" id="cancelBtn">Cancel</button></div>';
    d.showModal();
    d.addEventListener('close', () => resolve(false), { once: true });
    $('okBtn').onclick = () => { d.close(); resolve(true); };
    $('cancelBtn').onclick = () => { d.close(); resolve(false); };
  });
}

// ---------------------------------------------------------------- actions that are not transactions

const handlers = {
  'hosting-offer': () => showForm('Your hosting offer', [
    ['provider', 'Provider (your payout address)', wallet.address || ''],
    ['operator', 'Operator address (the key that signs pairings; not the provider)', ''],
    ['deviceKey', "Worker device key (imd status prints it; 64 hex)", state.vault?.deviceKey || ''],
    ['providerBps', 'Your share in basis points (3000 = 30%)', '3000'],
  ], async (f) => {
    const r = await api('/api/hosting-offer/build', { ...f, providerBps: Number(f.providerBps) });
    showText('Give this offer string to the owner', r.text);
  }),
  'create': () => showForm('Create the vault', [
    ['offer', "The host's offer string (seathost1:…)", state.hostingOffer ? '(imported)' : ''],
    ['tokenId', 'Seat token id', ''],
  ], async (f) => {
    if (f.offer && !f.offer.startsWith('(')) state = await api('/api/hosting-offer/import', { offer: f.offer });
    await sendTx('create', { tokenId: f.tokenId.trim() });
  }),
  'pairing-start': () => showForm('Start a pairing', [['deviceKey', 'Worker device key (must be the vault\'s)', state.vault?.deviceKey || '']], async (f) => {
    const p = await api('/api/pairing/start', { deviceKey: f.deviceKey.trim() });
    toast('Fresh pairing code shared with the owner. Waiting for approval.');
    await refreshState();
  }),
  'pairing-offer': () => showForm("Import the host's pairing offer", [['offer', 'seatpair1:…', '']], async (f) => { state = { ...state, pairing: await api('/api/pairing/import', { offer: f.offer }) }; toast('Pairing offer imported'); render(); }),
  'pairing-complete': async () => {
    if (busy) return;
    busy = true; render();
    try {
      if (state.config.operatorOnServer) {
        await api('/api/pairing/complete', {});
      } else {
        if (role() !== 'operator') throw new Error('connect the operator wallet to sign, or run the console with OPERATOR_KEY');
        const td = await api('/api/pairing/typed-data');
        const signature = await wallet.eth.request({ method: 'eth_signTypedData_v4', params: [wallet.address, JSON.stringify(td)] });
        await api('/api/pairing/complete', { signature });
      }
      toast('Pairing completed on IMD');
    } catch (e) { toast(e.message, true); }
    finally { busy = false; render(); }
  },
  'register-intent': async () => { try { await api('/api/register/intent', {}); toast('register-intent fetched and checked'); } catch (e) { toast(e.message, true); } render(); },
  'registerAgent': async () => { try { if (!state.registration?.intent) await api('/api/register/intent', {}); await sendTx('registerAgent'); } catch (e) { toast(e.message, true); } },
  'bind': async () => { try { await api('/api/register/bind', {}); toast('bind sent to IMD'); } catch (e) { toast(e.message, true); } render(); },
  'withdraw': () => showForm('Take the seat back', [['to', 'Send the NFT to', state.vault?.owner || '']], (f) => sendTx('withdraw', { to: f.to.trim() })),
};

function showForm(title, fields, onSubmit) {
  const d = $('dialog');
  $('dialogContent').innerHTML = `<h2>${esc(title)}</h2><form class="form" id="dialogForm">${fields.map(([k, label, value]) => `<label>${esc(label)}${k === 'offer' ? `<textarea name="${k}">${esc(value)}</textarea>` : `<input name="${k}" value="${esc(value)}">`}</label>`).join('')}<div style="display:flex;gap:10px"><button class="button primary" type="submit">Continue</button><button class="button" type="button" id="cancelBtn">Cancel</button></div></form>`;
  d.showModal();
  $('cancelBtn').onclick = () => d.close();
  $('dialogForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target).entries());
    d.close();
    try { await onSubmit(f); } catch (e) { toast(e.message, true); }
    render();
  };
}

function showText(title, text) {
  const d = $('dialog');
  $('dialogContent').innerHTML = `<h2>${esc(title)}</h2><p class="offer" id="offerText">${esc(text)}</p><div style="display:flex;gap:10px;margin-top:12px"><button class="button primary" id="copyBtn">Copy</button><button class="button" id="cancelBtn">Close</button></div>`;
  d.showModal();
  $('copyBtn').onclick = async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select and copy the text', true); } };
  $('cancelBtn').onclick = () => d.close();
}

// ---------------------------------------------------------------- rendering

function actionButton(a, mine) {
  if (a.passive) return `<div class="action wait">${esc(a.label)}</div>`;
  const blocked = (a.needs || []).length ? a.needs : [];
  const label = blocked.length ? `${a.label} (first: ${blocked.join(', ')})` : a.label;
  const id = blocked.length ? blocked[0] : a.id;
  const isTx = !handlers[id];
  return `<div class="action${a.secondary ? ' secondary' : ''}"><div class="row"><button class="button${a.secondary ? ' small' : ' primary'}" data-action="${esc(id)}" ${mine && !busy ? '' : 'disabled'}>${esc(label)}</button>${!mine ? '<span class="count">connect this role\'s wallet</span>' : ''}${isTx ? '' : ''}</div>${a.hint ? `<div class="hint">${esc(a.hint)}</div>` : ''}</div>`;
}

function dl(rows) {
  return rows.map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd class="${cls || ''}">${v}</dd>`).join('');
}

function link(addr, kind = 'address') {
  if (!addr) return '';
  const base = state.config.explorer;
  return base ? `<a href="${esc(base)}/${kind}/${esc(addr)}" target="_blank" rel="noreferrer">${esc(addr)}</a>` : esc(addr);
}

function render() {
  if (!state) return;
  const c = state.config;
  const v = state.vault;
  const r = role();
  $('chainNote').textContent = `chain ${c.chainId} · factory ${short(c.factory)} · IMD ${c.imdApi}`;
  $('walletBox').innerHTML = wallet.address
    ? `<span class="role-tag${r === 'viewer' || r === 'undecided' ? ' none' : ''}">${esc(r)}</span><span>${esc(short(wallet.address))}</span>${wallet.chainId !== c.chainId ? `<button class="button small" id="switchBtn">switch to chain ${c.chainId}</button>` : ''}`
    : '<button class="button small" id="connectBtn">Connect wallet</button>';
  $('connectBtn')?.addEventListener('click', connect);
  $('switchBtn')?.addEventListener('click', switchChain);
  $('vaultBox').innerHTML = v
    ? `vault ${link(v.address)} · seat #${esc(v.tokenId)} · host share ${v.providerBps / 100}% <button class="link" id="changeVault">change</button>`
    : 'no vault selected <button class="link" id="changeVault">select</button>';
  $('changeVault').onclick = selectVaultDialog;

  const setup = $('setup');
  if (!v) {
    setup.classList.remove('hidden');
    setup.innerHTML = `<h2>Start</h2><p>The host publishes a hosting offer; the owner creates the vault from it. Or select an existing vault by address.</p>${state.hostingOffer ? `<dl>${dl([['host', esc(state.hostingOffer.provider)], ['operator', esc(state.hostingOffer.operator)], ['device key', esc(state.hostingOffer.deviceKey)], ['host share', `${state.hostingOffer.providerBps / 100}%`]])}</dl>` : ''}`;
  } else setup.classList.add('hidden');

  const d = state.derived;
  $('steps').innerHTML = d.statuses.map((s) => `<li class="${s.status}"><i>${s.status === 'done' ? '✓ DONE' : s.status === 'current' ? '● NOW' : 'TODO'}</i><b>${esc(s.title)}</b></li>`).join('');
  $('ownerAddr').textContent = v ? v.owner : (state.hostingOffer ? 'the wallet that creates the vault' : '');
  $('hostAddr').textContent = v ? v.provider : (state.hostingOffer?.provider || '');
  $('ownerActions').innerHTML = d.owner.length ? d.owner.map((a) => actionButton(a, r === 'owner' || (!v && r !== 'host'))).join('') : '<div class="action wait">nothing to do now</div>';
  $('hostActions').innerHTML = d.host.length ? d.host.map((a) => actionButton(a, r === 'host' || (a.id === 'pairing-complete' && (r === 'operator' || c.operatorOnServer)) || (!v && r !== 'owner'))).join('') : '<div class="action wait">nothing to do now</div>';
  document.querySelectorAll('[data-action]').forEach((b) => { b.onclick = () => { const id = b.dataset.action; if (handlers[id]) handlers[id](); else sendTx(id); }; });

  const notes = [...(d.notes || []).map((n) => `<div class="note">${esc(n)}</div>`)];
  if (state.error) notes.push(`<div class="note error">${esc(state.error)}</div>`);
  if (state.imd?.lastError) notes.push(`<div class="note">${esc(state.imd.lastError)}</div>`);
  $('notes').innerHTML = notes.join('');

  if (v) {
    const seatIn = lower(v.seatOwner) === lower(v.address);
    $('custodyList').innerHTML = dl([
      ['seat holder', link(v.seatOwner), seatIn ? 'ok' : 'warn'],
      ['recorded as held', v.held ? 'yes' : 'no', v.held ? 'ok' : ''],
      ['agreement', v.ended ? `ended at ${new Date(v.endedAt * 1000).toISOString()}` : 'open', v.ended ? 'warn' : 'ok'],
      ['owner', link(v.owner)], ['host', link(v.provider)], ['operator', link(v.operator)],
      ['registrar', link(v.registrar)], ['relay', esc(v.relayOrigin)],
    ]);
    const p = state.pairing || {};
    const nowSec = Math.floor(state.now / 1000);
    const approvalLive = v.approvedUntil > nowSec && v.approvedDigest !== '0x' + '0'.repeat(64);
    $('pairingList').innerHTML = dl([
      ['device key', esc(v.deviceKey)],
      ['approved digest', approvalLive ? `${esc(v.approvedDigest)} until ${new Date(v.approvedUntil * 1000).toISOString()}` : 'none live', approvalLive ? 'ok' : ''],
      ['pairing code', p.code ? `${esc(p.code)}${p.codeExpiresAt ? ` (expires ${new Date(p.codeExpiresAt).toISOString()})` : ''}` : '—'],
      ['offer digest', p.artifact ? esc(p.artifact.digest) : '—', p.artifact && lower(p.artifact.digest) === lower(v.approvedDigest) ? 'ok' : ''],
      ['completed on IMD', p.completed ? `yes (${esc(p.completion?.status || '')})` : 'no', p.completed ? 'ok' : ''],
      ['offer string', p.offer ? `<span class="offer">${esc(p.offer)}</span>` : '—'],
    ]);
    const reg = state.registration || {};
    $('registrationList').innerHTML = dl([
      ['register-intent', reg.intent ? `${esc(reg.intent.data.slice(0, 10))}… → ${esc(reg.intent.to)}` : 'not fetched'],
      ['agent id', reg.agentId ? esc(reg.agentId) : (state.imd?.standing?.agentId ? `${esc(state.imd.standing.agentId)} (IMD)` : '—'), reg.agentId ? 'ok' : ''],
      ['registration tx', reg.txHash ? link(reg.txHash, 'tx') : '—'],
      ['bound on IMD', reg.bound ? 'yes' : (reg.bindResponse ? esc(JSON.stringify(reg.bindResponse.response)).slice(0, 120) : 'no'), reg.bound ? 'ok' : ''],
    ]);
    $('rewardsList').innerHTML = dl([
      ['vault balance', `${esc(v.rewardBalanceText)} ${esc(c.rewardSymbol)}`],
      ['unsettled', `${esc(v.pendingText)} ${esc(c.rewardSymbol)}`],
      ['owner claimable', `${esc(v.claimableOwnerText)} ${esc(c.rewardSymbol)}`],
      ['host claimable', `${esc(v.claimableProviderText)} ${esc(c.rewardSymbol)}`],
      ['shortfall', esc(v.shortfall) === '0' ? '0' : `${esc(v.shortfall)} base units`, esc(v.shortfall) === '0' ? '' : 'warn'],
    ]);
    const st = state.imd?.standing;
    $('imdNote').textContent = state.imd?.standingStatus === 404 ? 'seat never paired (404)' : (st ? 'seat standing' : 'no data yet');
    $('imdList').innerHTML = st ? dl([
      ['enrollment', esc(JSON.stringify(st.enrollment || null)).slice(0, 200), st.enrollment?.status ? 'ok' : ''],
      ['presence', esc(JSON.stringify(st.presence || null)).slice(0, 200)],
      ['agent', esc(st.agentId ?? '—')],
      ['work', esc(JSON.stringify(st.work || null)).slice(0, 200)],
    ]) : '';
  } else {
    for (const id of ['custodyList', 'pairingList', 'registrationList', 'rewardsList', 'imdList']) $(id).innerHTML = '';
    $('imdNote').textContent = '';
  }
  $('log').innerHTML = (state.log || []).slice().reverse().map((l) => `<li><time>${esc(l.at.replace('T', ' ').slice(0, 19))}</time><b>${esc(l.who)}</b><span>${esc(l.text)}</span></li>`).join('');
  setupRoom.render(state);
}

function selectVaultDialog() {
  showForm('Select a vault', [['address', 'Vault address', state.selectedVault || '']], async (f) => {
    state = await api('/api/vault', { address: f.address.trim() });
    toast('Vault selected');
  });
}

let importedRoom = false;
async function refreshState() { state = await api('/api/state'); render(); }
async function poll() {
  try {
    if (!importedRoom) {
      importedRoom = true;
      const vault = new URLSearchParams(location.hash.slice(1)).get('vault');
      if (/^0x[0-9a-fA-F]{40}$/.test(vault || '')) await api('/api/vault', { address: vault });
    }
    await refreshState();
  } catch (e) { setupRoom.disconnected(); $('notes').innerHTML = `<div class="note error">console server unreachable: ${esc(e.message)}</div>`; }
  setTimeout(poll, 3000);
}

$('resetBtn').onclick = async () => { if (confirm('Forget the selected vault, pairing and log on this console? Nothing on chain changes.')) { state = await api('/api/reset', {}); render(); } };
poll();
