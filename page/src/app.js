// The agreement page: one static file for the NFT owner and the host. It reads the vault through the connected
// wallet, reads IMD's open swarm listing, shows one next action, and asks the wallet to sign exactly the call it
// showed, under the same chain, account and vault. Nothing is stored anywhere but this browser: the selected
// vault, the pasted strings, the owner's mined approval and registration, unresolved and resolved transactions,
// a short history. Tabs of one browser coordinate through the Web Locks API and share one record.
import { providerClient, readVault, isFactoryVault, tx, waitReceipt, decodeLogs, vaultControlsAgent, workerAuthorizationDigest, formatUnits } from '../../host/lib/chain.js';
import { decodeOffer, validateHostingOffer, checkPairingOfferAgainstVault, validateIntent, validateArtifact, expiryProblems, HOSTING_PREFIX, PAIRING_PREFIX } from '../../host/lib/pairing.js';
import { derive } from '../../host/lib/steps.js';
import { emptyRecord, mergeRecords, pendingFor, settleReceipt, signingContext, contextUnchanged } from './guards.js';

const CONFIG = __CONFIG__; // baked in at build time from page/config.json
const KEY = `seat-page:${CONFIG.chainId}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const lower = (a) => String(a || '').toLowerCase();

// ---------------------------------------------------------------- the browser record (merged before every save)

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

/// The pasted pairing string as stored, if it decodes and is for this vault (its deadlines are not considered).
function storedArtifact() {
  if (!store.artifactText || !vault) return null;
  try {
    const a = decodeOffer(PAIRING_PREFIX, store.artifactText);
    return validateArtifact(a).length === 0 && lower(a.vault) === lower(vault.address) ? a : null;
  } catch { return null; }
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
  return { vault, artifact: liveArtifact(), approved: vault ? store.approved[lower(vault.address)] || null : null, intent: keptIntent(), registered: vault ? store.registered[lower(vault.address)] || null : null, pendingHashes: vault ? pendingFor(store.pending, vault.address).map(([h]) => h) : [], imdSeat, agentReusable };
}

/// One mined transaction becomes a record here, whether this tab sent it or found its receipt after a reload: the
/// receipt and the mined transaction are checked against the operation recorded at send time, and success
/// reconstructs the approval or the registration for the operation's own vault. Resolved for every tab.
async function applyReceipt(hash, receipt) {
  reload();
  if (!store.pending[lower(hash)]) return null;
  let sent = null;
  try { sent = await wallet.client.getTransaction({ hash }); } catch { sent = null; }
  // the settlement itself is serialized across tabs (a receipt two tabs found at once is settled by one of them)
  const settle = () => {
    reload();
    const op = store.pending[lower(hash)];
    if (!op) return null;
    const agentId = op.action === 'registerAgent' ? (decodeLogs(receipt).find((e) => e.name === 'AgentRegistered' && lower(e.address) === lower(op.vault))?.args.agentId ?? null) : null;
    const r = settleReceipt(store, hash, receipt, sent, { agentId });
    store = r.record;
    save();
    const what = op.action === 'approvePairing' ? 'approval' : op.action === 'registerAgent' ? 'registration' : op.action;
    log(`${what} ${short(lower(hash))} ${r.status === 'success' ? 'mined' : r.status === 'reverted' ? 'reverted' : 'does not match what this page sent'}`);
    return r;
  };
  return navigator.locks ? navigator.locks.request(`${KEY}:record`, settle) : settle();
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
      // unresolved transactions of any vault: a receipt settles them, whichever tab sent them
      for (const [hash] of pendingFor(store.pending)) {
        try { const r = await wallet.client.getTransactionReceipt({ hash }); if (r) await applyReceipt(hash, r); } catch { /* still pending */ }
      }
      // a tab closed while the wallet prompt was open leaves no hash; the approval of exactly the pasted string's
      // digest, live on the vault, is evidence enough and is recorded so it survives the string's deadlines
      const art = storedArtifact();
      if (art && !store.approved[lower(vault.address)] && lower(vault.approvedDigest) === lower(art.digest) && vault.approvedUntil > Math.floor(Date.now() / 1000)) {
        reload();
        store.approved[lower(vault.address)] = { digest: art.digest, code: art.code, at: new Date().toISOString(), source: 'chain' };
        save();
        log(`approval for code ${art.code} seen on the vault`);
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

/// Tabs of this browser take turns per vault through the Web Locks API: the lock is held from before the wallet
/// request until the hash is durably recorded, and a tab that closes releases it. Nothing is time-based, and no tab
/// can clear another tab's lock. Web Locks need a secure context (https, or localhost).
function withVaultLock(vaultAddr, fn) {
  if (!navigator.locks) return Promise.reject(new Error('tab coordination needs this page served over https (or localhost); nothing was sent'));
  return navigator.locks.request(`${KEY}:vault:${lower(vaultAddr)}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('another tab is sending a transaction for this agreement; nothing was sent');
    return fn();
  });
}

/// `protect` (an object, with the digest and code for an approval) marks an operation this browser must be able to
/// recover: it is refused while another one for the vault is unresolved, refused without durable storage, and its
/// hash is recorded with its context before the lock is released.
async function sendTx(action, built, title, text, { protect = null, recheck = () => null } = {}) {
  if (busy) return null;
  if (!onChain()) { toast(`Connect the wallet on chain ${CONFIG.chainId} first.`, true); return null; }
  const reviewed = signingContext({ chainId: wallet.chainId, account: wallet.address, vault: vault?.address, action, to: built.to, data: built.data });
  const vaultAddr = vault?.address || null;
  busy = true; render();
  try {
    const ok = await confirmDialog(`<h2>${esc(title)}</h2><p>${esc(text)}</p><p class="hint">This is an on-chain transaction; your wallet shows the gas cost.</p><details><summary>Exact transaction</summary><p class="offer">To ${esc(built.to)}<br>Data ${esc(built.data)}</p></details>`);
    if (!ok) return null;
    const send = async () => {
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
        if (pendingFor(store.pending, vaultAddr).length) throw new Error('an earlier transaction for this agreement is still unresolved; nothing was sent');
        try { localStorage.setItem(KEY + ':probe', '1'); localStorage.removeItem(KEY + ':probe'); } catch { storageOk = false; }
        if (!storageOk) throw new Error('this browser cannot keep a record of the approval; use a browser where site data is allowed');
      }
      const h = await wallet.eth.request({ method: 'eth_sendTransaction', params: [{ from: wallet.address, to: built.to, data: built.data, value: '0x0' }] });
      if (protect) {
        reload();
        store.pending[lower(h)] = { vault: lower(vaultAddr), action, to: lower(built.to), data: built.data, ...protect, at: new Date().toISOString() };
        save();
        if (!storageOk) toast(`${title}: sent, but this browser could not record it; do not send another before it is mined`, true);
      }
      return h;
    };
    const hash = protect ? await withVaultLock(vaultAddr, send) : await send();
    log(`${title}: sent ${hash}`);
    toast(`${title}: sent, waiting for confirmation`);
    render();
    const receipt = await waitReceipt(wallet.client, hash);
    if (protect) await applyReceipt(hash, receipt);
    else log(`${title}: ${receipt.status === 'success' ? 'confirmed' : 'reverted'} in block ${receipt.blockNumber}`);
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
  reload();
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
    await sendTx('approvePairing', tx.approvePairing(vault.address, a.message.nonce, a.message.expiresAt, a.message.relayOrigin), 'Approve the pairing', `Approve exactly this pairing (code ${a.code}) for your host's device. It must be mined before ${new Date(a.message.expiresAt * 1000).toLocaleTimeString()}.`,
      { protect: { digest: a.digest, code: a.code }, recheck: () => (expiryProblems(a, Date.now()).length ? 'the pairing string expired while you were reviewing; ask the host for a fresh one' : null) });
  },
  registerAgent: async () => {
    const intent = keptIntent();
    if (!intent) { toast('No valid registration intent in hand; paste the pairing string again.', true); return; }
    await sendTx('registerAgent', tx.registerAgent(vault.address, intent.data), 'Register the agent', "IMD's registration for this seat, sent through the vault. The page checked it names this seat and IMD's registrar.", { protect: {} });
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
      ['your mined approval', s.approved ? `code ${esc(s.approved.code)} at ${esc(s.approved.at)}${s.approved.txHash ? ` (${esc(short(s.approved.txHash))})` : ' (seen on the vault)'}` : '—'],
      ['unresolved transactions', s.pendingHashes.length ? esc(s.pendingHashes.join(', ')) : 'none'],
      ['registration kept', s.intent ? 'yes' : '—'], ['your registration', s.registered ? `agent ${esc(s.registered.agentId ?? '?')} in ${esc(short(s.registered.txHash))}` : '—'],
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
