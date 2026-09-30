// The agreement page: one static file for the NFT owner and the host. It reads the vault through the connected
// wallet, reads IMD's open swarm listing, shows one next action, and asks the wallet to sign exactly the call it
// showed, under the same chain, account and vault. Nothing is stored anywhere but this browser: the selected
// vault, the pasted strings, the owner's mined approval and registration, unresolved approvals, a short history.
import { providerClient, readVault, isFactoryVault, tx, waitReceipt, decodeLogs, vaultControlsAgent, workerAuthorizationDigest, formatUnits } from '../../host/lib/chain.js';
import { decodeOffer, validateHostingOffer, checkPairingOfferAgainstVault, validateIntent, expiryProblems, HOSTING_PREFIX, PAIRING_PREFIX } from '../../host/lib/pairing.js';
import { derive } from '../../host/lib/steps.js';
import { emptyRecord, mergeRecords, signingContext, contextUnchanged, lockIsFree } from './guards.js';

const CONFIG = __CONFIG__; // baked in at build time from page/config.json
const KEY = `seat-page:${CONFIG.chainId}`;
const LOCK = `${KEY}:lock`;
const ZERO = '0x0000000000000000000000000000000000000000';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const lower = (a) => String(a || '').toLowerCase();

// ---------------------------------------------------------------- the browser record (merged before every protected step)

let store = emptyRecord();
let storageOk = true;

function readStorage() {
  try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function reload() { store = mergeRecords(store, readStorage()); }
function save() {
  reload();
  store.seq = (Number(store.seq) || 0) + 1;
  try { localStorage.setItem(KEY, JSON.stringify(store)); storageOk = true; } catch { storageOk = false; }
}
function log(text) { store.log.push({ at: new Date().toISOString(), text }); if (store.log.length > 200) store.log.splice(0, store.log.length - 200); save(); }
const perVault = (map, vault) => (map[lower(vault)] ||= []);
window.addEventListener('storage', (e) => { if (e.key === KEY) { reload(); render(); } });
reload();

// ---------------------------------------------------------------- wallet and chain

const wallet = { eth: null, address: null, chainId: null, client: null };
let vault = null; // the latest readVault snapshot of store.vault
let vaultProven = null; // factory provenance of store.vault: true / false / null (not checked yet)
let imdSeat = null;
let imdChecked = false;
let agentReusable = null; // true / false / null
let busy = false;
let imdAt = 0;

async function connect() {
  const eth = window.ethereum;
  if (!eth) { toast('No wallet found. Open this page in a browser with Rabby or MetaMask.', true); return; }
  wallet.eth = eth;
  wallet.client = providerClient(eth);
  const accounts = await eth.request({ method: 'eth_requestAccounts' });
  wallet.address = accounts[0] || null;
  wallet.chainId = parseInt(await eth.request({ method: 'eth_chainId' }), 16);
  eth.on?.('accountsChanged', (a) => { wallet.address = a[0] || null; render(); });
  eth.on?.('chainChanged', (c) => { wallet.chainId = parseInt(c, 16); vault = null; vaultProven = null; refresh(); });
  await refresh();
}

async function switchChain() {
  try { await wallet.eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + CONFIG.chainId.toString(16) }] }); } catch (e) { toast(`Could not switch: ${e.message}`, true); }
}

const onChain = () => wallet.client && wallet.chainId === CONFIG.chainId;

function role() {
  if (!wallet.address) return 'none';
  if (!vault) return 'undecided';
  const a = lower(wallet.address);
  if (a === lower(vault.owner)) return 'owner';
  if (a === lower(vault.provider)) return 'host';
  return 'viewer';
}

/// The pasted pairing string, only while it still checks out against the vault and both its deadlines are ahead.
function liveArtifact() {
  if (!store.artifactText || !vault) return null;
  try { const a = decodeOffer(PAIRING_PREFIX, store.artifactText); return checkPairingOfferAgainstVault(a, vault, CONFIG).length === 0 ? a : null; } catch { return null; }
}

/// The registration intent kept apart from the pairing string, so the pairing deadline never gates registration.
function keptIntent() {
  const i = vault ? store.intents[lower(vault.address)] : null;
  if (!i || !vault) return null;
  return validateIntent(i, { registrar: CONFIG.registrar, chain: CONFIG.chainId, collection: CONFIG.collection, token: vault.tokenId }).length === 0 ? i : null;
}

function snapshot() {
  return { vault, artifact: liveArtifact(), approved: vault ? store.approved[lower(vault.address)] || null : null, intent: keptIntent(), registered: vault ? store.registered[lower(vault.address)] || null : null, pendingHashes: vault ? perVault(store.pendingApprovals, vault.address) : [], imdSeat, agentReusable };
}

async function refresh() {
  if (!onChain()) { render(); return; }
  try {
    if (store.vault) {
      const selected = store.vault;
      if (vaultProven !== true || lower(vault?.address) !== lower(selected)) {
        vaultProven = await isFactoryVault(wallet.client, CONFIG.factory, selected, { fromBlock: CONFIG.factoryBlock || 0 });
        if (!vaultProven) { vault = null; render(); return; }
      }
      const v = await readVault(wallet.client, selected);
      if (lower(v.collection) !== lower(CONFIG.collection)) { vaultProven = false; vault = null; render(); return; }
      if (lower(vault?.address) !== lower(v.address)) { imdSeat = null; imdChecked = false; agentReusable = null; imdAt = 0; }
      vault = v;
      reload();
      const list = perVault(store.pendingApprovals, vault.address);
      for (const hash of [...list]) {
        try { const r = await wallet.client.getTransactionReceipt({ hash }); if (r) { list.splice(list.indexOf(hash), 1); save(); log(`approval ${short(hash)} ${r.status === 'success' ? 'mined' : 'reverted'}`); } } catch { /* still pending */ }
      }
      if (Date.now() - imdAt > 30_000) {
        imdAt = Date.now();
        try {
          const r = await fetch(`${CONFIG.imdApi}/swarm`, { signal: AbortSignal.timeout(15_000) });
          const j = await r.json();
          imdSeat = j && j.seats ? j.seats[String(vault.tokenId)] || null : null;
          imdChecked = true;
          agentReusable = imdSeat && imdSeat.agentId ? await vaultControlsAgent(wallet.client, CONFIG.registrar, imdSeat.agentId, vault.address, CONFIG.collection, vault.tokenId) : null;
        } catch { imdSeat = null; imdChecked = false; agentReusable = null; }
      }
    } else { vault = null; vaultProven = null; }
  } catch (e) { toast(`Chain read failed: ${e.shortMessage || e.message}`, true); }
  render();
}

// ---------------------------------------------------------------- sending a prepared call

async function sendTx(action, built, title, text, { protect = false, recheck = () => null } = {}) {
  if (busy) return null;
  if (!onChain()) { toast(`Connect the wallet on chain ${CONFIG.chainId} first.`, true); return null; }
  const reviewed = signingContext({ chainId: wallet.chainId, account: wallet.address, vault: vault?.address, action, to: built.to, data: built.data });
  busy = true; render();
  try {
    if (protect) { try { localStorage.setItem(LOCK + ':probe', '1'); localStorage.removeItem(LOCK + ':probe'); } catch { storageOk = false; } }
    if (protect && !storageOk) throw new Error('this browser cannot keep a record of the approval; use a browser where site data is allowed');
    const ok = await confirmDialog(`<h2>${esc(title)}</h2><p>${esc(text)}</p><p class="hint">This is an on-chain transaction; your wallet shows the gas cost.</p><details><summary>Exact transaction</summary><p class="offer">To ${esc(built.to)}<br>Data ${esc(built.data)}</p></details>`);
    if (!ok) return null;
    // the wallet request is made under the reviewed context or not at all
    const chainNow = parseInt(await wallet.eth.request({ method: 'eth_chainId' }), 16);
    const accounts = await wallet.eth.request({ method: 'eth_accounts' });
    wallet.chainId = chainNow; wallet.address = accounts[0] || null;
    const current = signingContext({ chainId: chainNow, account: wallet.address, vault: vault?.address, action, to: built.to, data: built.data });
    if (!contextUnchanged(reviewed, current)) throw new Error('the wallet, chain or agreement changed while you were reviewing; nothing was sent');
    const why = recheck();
    if (why) throw new Error(why);
    if (protect) {
      reload();
      if (perVault(store.pendingApprovals, vault.address).length) throw new Error('an earlier approval is still unresolved; nothing was sent');
      if (!lockIsFree(localStorage.getItem(LOCK + ':' + lower(vault.address)))) throw new Error('another tab is sending an approval for this vault; nothing was sent');
      localStorage.setItem(LOCK + ':' + lower(vault.address), String(Date.now()));
    }
    let hash;
    try { hash = await wallet.eth.request({ method: 'eth_sendTransaction', params: [{ from: wallet.address, to: built.to, data: built.data, value: '0x0' }] }); }
    finally { if (protect) localStorage.removeItem(LOCK + ':' + lower(vault.address)); }
    log(`${title}: sent ${hash}`);
    if (protect) { perVault(store.pendingApprovals, vault.address).push(hash); save(); render(); }
    toast(`${title}: sent, waiting for confirmation`);
    const receipt = await waitReceipt(wallet.client, hash);
    if (protect) { reload(); const l = perVault(store.pendingApprovals, vault.address); const i = l.indexOf(hash); if (i >= 0) l.splice(i, 1); save(); }
    log(`${title}: ${receipt.status === 'success' ? 'confirmed' : 'reverted'} in block ${receipt.blockNumber}`);
    if (receipt.status !== 'success') toast(`${title}: the transaction reverted`, true);
    return receipt;
  } catch (e) { toast(e.shortMessage || e.message, true); return null; }
  finally { busy = false; await refresh(); }
}

function confirmDialog(html) {
  return new Promise((resolve) => {
    const d = $('dialog');
    $('dialogContent').innerHTML = html + '<div style="display:flex;gap:10px;margin-top:16px"><button class="button" id="okBtn">Continue in wallet</button><button class="button" id="cancelBtn">Cancel</button></div>';
    d.addEventListener('close', () => resolve(false), { once: true });
    d.showModal();
    $('okBtn').onclick = () => { resolve(true); d.close(); };
    $('cancelBtn').onclick = () => d.close();
  });
}

function showForm(title, fields, onSubmit) {
  const d = $('dialog');
  $('dialogContent').innerHTML = `<h2>${esc(title)}</h2><form class="form" id="dialogForm">${fields.map(([k, label, value, area]) => `<label>${esc(label)}${area ? `<textarea name="${k}">${esc(value)}</textarea>` : `<input name="${k}" value="${esc(value)}">`}</label>`).join('')}<div style="display:flex;gap:10px"><button class="button" type="submit">Continue</button><button class="button" type="button" id="cancelBtn">Cancel</button></div></form>`;
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

function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'visible' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ''; }, isError ? 9000 : 4000);
}

// ---------------------------------------------------------------- the actions

async function selectVault(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('not an address');
  if (!(await isFactoryVault(wallet.client, CONFIG.factory, address, { fromBlock: CONFIG.factoryBlock || 0 }))) throw new Error('that address was not created by this factory; the page only works with vaults the factory made');
  const v = await readVault(wallet.client, address);
  if (lower(v.collection) !== lower(CONFIG.collection)) throw new Error('that vault is for another collection');
  store.vault = address; store.artifactText = null; save();
  vault = null; vaultProven = null; imdSeat = null; imdChecked = false; agentReusable = null; imdAt = 0;
  await refresh();
}

const actions = {
  create: () => showForm('Create the vault', [['offer', "The host's hosting offer (seathost1:…)", '', true], ['tokenId', 'Your seat token id', '']], async (f) => {
    const offer = decodeOffer(HOSTING_PREFIX, f.offer);
    const problems = validateHostingOffer(offer, { chain: CONFIG.chainId, relay: CONFIG.relayOrigin, collection: CONFIG.collection });
    if (problems.length) throw new Error(problems.join('; '));
    if (!/^\d+$/.test(f.tokenId.trim())) throw new Error('the token id must be a whole number');
    const receipt = await sendTx('create', tx.create(CONFIG.factory, { provider: offer.provider, operator: offer.operator, tokenId: f.tokenId.trim(), providerBps: offer.providerBps, deviceKey: offer.deviceKey }),
      'Create the vault', `A vault for seat #${f.tokenId.trim()} with host ${short(offer.provider)}: you keep ${100 - offer.providerBps / 100}%, the host receives ${offer.providerBps / 100}%. No daily fee, no deposit.`);
    if (!receipt) return;
    const created = decodeLogs(receipt).find((e) => e.name === 'VaultCreated' && lower(e.address) === lower(CONFIG.factory));
    if (!created) throw new Error('no VaultCreated event in the receipt');
    log(`vault ${created.args.vault} created`);
    await selectVault(created.args.vault);
    toast('Vault created. Send its address to your host.');
  }),
  deposit: () => sendTx('deposit', tx.depositSeat(CONFIG.collection, wallet.address, vault.address, vault.tokenId), 'Move my NFT into the vault', 'Your NFT moves into its vault in one safe transfer. You can take it back at any time.'),
  syncHeld: () => sendTx('syncHeld', tx.syncHeld(vault.address), 'Record the NFT as held', 'The NFT is already in the vault; this records it so pairing can be approved.'),
  'pairing-offer': () => showForm("Paste the host's pairing string", [['offer', 'seatpair1:…', '', true]], async (f) => {
    const a = decodeOffer(PAIRING_PREFIX, f.offer);
    const problems = checkPairingOfferAgainstVault(a, vault, CONFIG);
    if (problems.length) throw new Error(problems.join('; '));
    const digest = await workerAuthorizationDigest(wallet.client, vault.address, a.message.deviceKey, a.message.nonce, a.message.expiresAt);
    if (lower(digest) !== lower(a.digest)) throw new Error("the string's digest does not match what this vault computes");
    reload();
    store.artifactText = f.offer.trim();
    if (a.intent) store.intents[lower(vault.address)] = a.intent; // kept apart from the string: its own checks, no pairing deadline
    save();
    log(`pairing string ${a.code} accepted; approve before ${new Date(a.message.expiresAt * 1000).toISOString()}`);
    await refresh();
  }),
  approvePairing: async () => {
    const a = liveArtifact();
    if (!a) { toast('The pairing string expired; ask the host for a fresh one.', true); return; }
    const receipt = await sendTx('approvePairing', tx.approvePairing(vault.address, a.message.nonce, a.message.expiresAt, a.message.relayOrigin), 'Approve the pairing', `Approve exactly this pairing (code ${a.code}) for your host's device. It must be mined before ${new Date(a.message.expiresAt * 1000).toLocaleTimeString()}.`,
      { protect: true, recheck: () => (expiryProblems(a, Date.now()).length ? 'the pairing string expired while you were reviewing; ask the host for a fresh one' : null) });
    if (receipt && receipt.status === 'success') { reload(); store.approved[lower(vault.address)] = { digest: a.digest, code: a.code, at: new Date().toISOString() }; save(); log(`pairing ${a.code} approved; your host completes it`); }
  },
  registerAgent: async () => {
    const intent = keptIntent();
    if (!intent) { toast('No valid registration intent in hand; paste the pairing string again.', true); return; }
    const receipt = await sendTx('registerAgent', tx.registerAgent(vault.address, intent.data), 'Register the agent', "IMD's registration for this seat, sent through the vault. The page checked it names this seat and IMD's registrar.");
    if (receipt && receipt.status === 'success') {
      const ev = decodeLogs(receipt).find((e) => e.name === 'AgentRegistered');
      reload(); store.registered[lower(vault.address)] = { agentId: ev ? ev.args.agentId : null, txHash: receipt.transactionHash }; save();
      log(`agent ${ev ? ev.args.agentId : '?'} registered; your host binds it on IMD`);
    }
  },
  claim: () => sendTx('claim', tx.claim(vault.address), 'Claim my rewards', 'Sends your share of the rewards in the vault to your wallet.'),
  withdraw: () => showForm('Take my NFT back', [['to', 'Send the NFT to', wallet.address || '']], (f) => sendTx('withdraw', tx.withdraw(vault.address, f.to.trim()), 'Take my NFT back', 'Ends the agreement and returns the NFT in one transaction. Rewards already here stay claimable.')),
  selectVault: () => showForm('Open an agreement', [['address', 'Vault address', store.vault || '']], (f) => selectVault(f.address.trim())),
};

// ---------------------------------------------------------------- rendering

function render() {
  const r = role();
  const c = CONFIG;
  $('walletBox').innerHTML = wallet.address
    ? `<span class="role-tag${['viewer', 'undecided', 'none'].includes(r) ? ' none' : ''}">${esc(r)}</span><span>${esc(short(wallet.address))}</span>${wallet.chainId !== c.chainId ? `<button class="button small" id="switchBtn">switch to chain ${c.chainId}</button>` : ''}`
    : '<button class="button small" id="connectBtn">Connect wallet</button>';
  $('connectBtn')?.addEventListener('click', connect);
  $('switchBtn')?.addEventListener('click', switchChain);
  $('vaultBox').innerHTML = vault
    ? `vault ${c.explorer ? `<a href="${esc(c.explorer)}/address/${esc(vault.address)}" target="_blank" rel="noreferrer">${esc(vault.address)}</a>` : esc(vault.address)} · seat #${esc(vault.tokenId)} · host share ${vault.providerBps / 100}% <button class="link" id="changeVault">change</button>`
    : (store.vault ? `vault ${esc(store.vault)} ${vaultProven === false ? '(refused: not made by this factory)' : '(connect the wallet to read it)'} <button class="link" id="changeVault">change</button>` : '<button class="link" id="changeVault">open an existing agreement</button>');
  $('changeVault')?.addEventListener('click', actions.selectVault);

  const main = $('main');
  const notes = [];
  if (lower(c.factory) === ZERO) notes.push('<div class="note error">This page has no factory address configured yet; nothing can be created until the contracts are deployed.</div>');
  if (!storageOk) notes.push('<div class="note error">This browser refuses to store the page\'s record; approvals are disabled here because an unresolved one could be forgotten.</div>');
  if (!wallet.address) {
    main.innerHTML = `<span class="eyebrow">ONE NFT / ONE HOST</span><h1>Your NFT, hosted</h1><p class="lead">Hand your seat to a host who runs the worker. Rewards split by a fixed share, no fee, no deposit, and you can take the NFT back at any time.</p><button class="button primary" id="connectMain">Connect wallet</button><p class="hint">Reads go through your wallet's own connection; nothing is sent anywhere until you approve a transaction.</p>`;
    $('connectMain').onclick = connect;
  } else if (!onChain()) {
    main.innerHTML = `<span class="eyebrow">ONE NFT / ONE HOST</span><h1>Wrong network</h1><p class="lead">Switch your wallet to chain ${c.chainId}.</p><button class="button primary" id="switchMain">Switch network</button>`;
    $('switchMain').onclick = switchChain;
  } else if (!vault) {
    main.innerHTML = `<span class="eyebrow">ONE NFT / ONE HOST</span><h1>Start</h1><p class="lead">Ask your host for their hosting offer string, then create the vault for your seat. Or open an agreement that already exists.</p><button class="button primary" data-action="create" ${lower(c.factory) === ZERO ? 'disabled' : ''}>Create the vault</button><div class="actions"><button class="button small" data-action="selectVault">Open an existing agreement</button></div>`;
  } else {
    const d = derive(snapshot());
    const mine = r === 'owner' ? d.owner : r === 'host' ? d.host : [];
    const primary = mine.find((a) => !a.passive && !a.secondary);
    const waiting = mine.find((a) => a.passive);
    const secondary = mine.filter((a) => a.secondary);
    const titles = { create: 'Start', deposit: 'Move your NFT in', pair: 'Approve the pairing', register: 'Register the agent', done: 'Your side is done', exit: vault.ended && lower(vault.seatOwner) !== lower(vault.address) ? 'Agreement ended' : 'Take your NFT back' };
    const seatIn = lower(vault.seatOwner) === lower(vault.address);
    const a = liveArtifact();
    main.innerHTML = `<span class="eyebrow">ONE NFT / ONE HOST</span><h1>${esc(titles[d.step])}</h1>
      <span class="status${d.step === 'done' ? '' : ' warn'}">${esc(d.step === 'done' ? 'SET UP · HOST CONFIRMS' : d.step.toUpperCase())}</span>
      <div class="split"><span>NFT <b>#${esc(vault.tokenId)}</b></span><span>Owner keeps <b>${100 - vault.providerBps / 100}%</b></span><span>Host receives <b>${vault.providerBps / 100}%</b></span><span>No daily fee</span></div>
      ${primary ? `<button class="button primary" data-action="${esc(primary.id)}" ${busy ? 'disabled' : ''}>${esc(primary.label)}</button>${primary.hint ? `<p class="hint">${esc(primary.hint)}</p>` : ''}` : waiting ? `<div class="wait">${esc(waiting.label)}</div>` : (r === 'viewer' ? '<div class="wait">Connect the owner\'s or the host\'s wallet to act.</div>' : '<div class="wait">Nothing to do right now.</div>')}
      ${a && d.step === 'pair' ? `<p class="hint">Pairing code ${esc(a.code)} · approve before ${esc(new Date(a.message.expiresAt * 1000).toLocaleTimeString())}</p>` : ''}
      ${secondary.length ? `<div class="actions">${secondary.map((x) => `<button class="button small" data-action="${esc(x.id)}" ${busy ? 'disabled' : ''}>${esc(x.label)}</button>`).join('')}</div>` : ''}`;
    for (const n of d.notes) notes.push(`<div class="note">${esc(n)}</div>`);
    if (!imdChecked) notes.push('<div class="note">IMD\'s listing could not be read yet; its status is unknown, not empty.</div>');
    const s = snapshot();
    $('details').innerHTML = `<dl>${[
      ['NFT holder', esc(vault.seatOwner), seatIn ? 'ok' : ''], ['recorded as held', vault.held ? 'yes' : 'no', vault.held ? 'ok' : ''], ['agreement', vault.ended ? 'ended' : 'open', vault.ended ? '' : 'ok'],
      ['owner', esc(vault.owner)], ['host', esc(vault.provider)], ['operator', esc(vault.operator)], ['device key', esc(vault.deviceKey)],
      ['live approval on the vault', vault.approvedUntil > Date.now() / 1000 ? `${esc(vault.approvedDigest)} until ${esc(new Date(vault.approvedUntil * 1000).toISOString())}` : 'none'],
      ['your mined approval', s.approved ? `code ${esc(s.approved.code)} at ${esc(s.approved.at)}` : '—'],
      ['unresolved approvals', s.pendingHashes.length ? esc(s.pendingHashes.join(', ')) : 'none'],
      ['registration kept', s.intent ? 'yes' : '—'], ['your registration', s.registered ? `agent ${esc(s.registered.agentId)} in ${esc(short(s.registered.txHash))}` : '—'],
      ['existing agent reusable', s.agentReusable === true ? 'yes' : s.agentReusable === false ? 'no' : 'unknown'],
      ['rewards in the vault', `${esc(formatUnits(vault.rewardBalance, c.rewardDecimals))} ${esc(c.rewardSymbol)} (unsettled ${esc(formatUnits(vault.pending, c.rewardDecimals))})`],
      ['owner claimable', `${esc(formatUnits(vault.claimableOwner, c.rewardDecimals))} ${esc(c.rewardSymbol)}`], ['host claimable', `${esc(formatUnits(vault.claimableProvider, c.rewardDecimals))} ${esc(c.rewardSymbol)}`],
      ['pairing string', store.artifactText ? `<span class="offer">${esc(store.artifactText)}</span>` : '—'],
    ].map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd class="${cls || ''}">${v}</dd>`).join('')}</dl>
      <h2>Steps</h2><p class="hint">${d.statuses.map((x) => `${x.status === 'done' ? '✓' : x.status === 'current' ? '●' : '○'} ${esc(x.title)}`).join(' · ')}</p>
      <h2>History (this browser)</h2><ol class="log">${store.log.slice().reverse().map((l) => `<li><time>${esc(l.at.replace('T', ' ').slice(0, 19))}</time>${esc(l.text)}</li>`).join('')}</ol>`;
  }
  $('notes').innerHTML = notes.join('');
  document.querySelectorAll('[data-action]').forEach((b) => { b.onclick = () => actions[b.dataset.action]?.(); });
}

$('resetBtn').onclick = () => { if (confirm('Forget the vault, pasted strings and history kept in this browser? Nothing on chain changes.')) { try { localStorage.removeItem(KEY); } catch { /* nothing to forget */ } location.reload(); } };
render();
if (window.ethereum && store.vault) connect().catch(() => render());
setInterval(() => { if (!busy && onChain() && store.vault) refresh(); }, 6000);
