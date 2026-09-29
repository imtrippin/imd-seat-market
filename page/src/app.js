// The agreement page: one static file for the NFT owner and the host. It reads the vault through the connected
// wallet, reads IMD's open swarm listing, shows one next action, and asks the wallet to sign exactly the call it
// shows. Nothing is stored anywhere but this browser (the selected vault, the pasted strings, unresolved approvals).
import { providerClient, readVault, tx, waitReceipt, decodeLogs, vaultControlsAgent, workerAuthorizationDigest, formatUnits } from '../../host/lib/chain.js';
import { decodeOffer, validateHostingOffer, checkPairingOfferAgainstVault, HOSTING_PREFIX, PAIRING_PREFIX } from '../../host/lib/pairing.js';
import { derive, STEPS } from '../../host/lib/steps.js';

const CONFIG = __CONFIG__; // baked in at build time from page/config.json
const KEY = `seat-page:${CONFIG.chainId}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const lower = (a) => String(a || '').toLowerCase();

// ---------------------------------------------------------------- browser-side record

function loadStore() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || '{}'); return { vault: null, artifactText: null, pendingApprovals: {}, log: [], ...s }; } catch { return { vault: null, artifactText: null, pendingApprovals: {}, log: [] }; }
}
const store = loadStore();
function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* private mode: the page still works for this visit */ } }
function log(text) { store.log.push({ at: new Date().toISOString(), text }); if (store.log.length > 200) store.log.splice(0, store.log.length - 200); save(); }
const pendingFor = (vault) => (store.pendingApprovals[lower(vault)] ||= []);

// ---------------------------------------------------------------- wallet and chain

const wallet = { eth: null, address: null, chainId: null, client: null };
let vault = null; // the latest readVault snapshot
let imdSeat = null;
let agentReusable = null;
let artifact = null;
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
  eth.on?.('chainChanged', (c) => { wallet.chainId = parseInt(c, 16); refresh(); });
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

async function refresh() {
  if (!onChain()) { render(); return; }
  try {
    if (store.vault) {
      vault = await readVault(wallet.client, store.vault);
      // unresolved approvals: prune the ones that mined
      const list = pendingFor(vault.address);
      for (const hash of [...list]) {
        try { const r = await wallet.client.getTransactionReceipt({ hash }); if (r) { list.splice(list.indexOf(hash), 1); log(`approval ${short(hash)} ${r.status === 'success' ? 'mined' : 'reverted'}`); } } catch { /* still pending */ }
      }
      if (Date.now() - imdAt > 30_000) {
        imdAt = Date.now();
        try {
          const r = await fetch(`${CONFIG.imdApi}/swarm`, { signal: AbortSignal.timeout(15_000) });
          const j = await r.json();
          imdSeat = j && j.seats ? j.seats[String(vault.tokenId)] || null : null;
          agentReusable = imdSeat && imdSeat.agentId ? await vaultControlsAgent(wallet.client, CONFIG.registrar, imdSeat.agentId, vault.address) : null;
        } catch { /* IMD unreachable: shown as unknown */ }
      }
      artifact = null;
      if (store.artifactText) { try { const a = decodeOffer(PAIRING_PREFIX, store.artifactText); if (checkPairingOfferAgainstVault(a, vault, CONFIG).length === 0) artifact = a; } catch { /* stale string */ } }
    } else vault = null;
  } catch (e) { toast(`Chain read failed: ${e.shortMessage || e.message}`, true); }
  render();
}

// ---------------------------------------------------------------- sending a prepared call

async function sendTx(built, title, text, { pending = false } = {}) {
  if (busy) return null;
  if (!onChain()) { toast(`Connect the wallet on chain ${CONFIG.chainId} first.`, true); return null; }
  busy = true; render();
  try {
    const ok = await confirmDialog(`<h2>${esc(title)}</h2><p>${esc(text)}</p><p class="hint">This is an on-chain transaction; your wallet shows the gas cost.</p><details><summary>Exact transaction</summary><p class="offer">To ${esc(built.to)}<br>Data ${esc(built.data)}</p></details>`);
    if (!ok) return null;
    const hash = await wallet.eth.request({ method: 'eth_sendTransaction', params: [{ from: wallet.address, to: built.to, data: built.data, value: '0x0' }] });
    log(`${title}: sent ${hash}`);
    if (pending && store.vault) { pendingFor(store.vault).push(hash); save(); render(); }
    toast(`${title}: sent, waiting for confirmation`);
    const receipt = await waitReceipt(wallet.client, hash);
    if (pending && store.vault) { const l = pendingFor(store.vault); const i = l.indexOf(hash); if (i >= 0) l.splice(i, 1); save(); }
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

const actions = {
  create: () => showForm('Create the vault', [['offer', "The host's hosting offer (seathost1:…)", '', true], ['tokenId', 'Your seat token id', '']], async (f) => {
    const offer = decodeOffer(HOSTING_PREFIX, f.offer);
    const problems = validateHostingOffer(offer, { chain: CONFIG.chainId, relay: CONFIG.relayOrigin, collection: CONFIG.collection });
    if (problems.length) throw new Error(problems.join('; '));
    if (!/^\d+$/.test(f.tokenId.trim())) throw new Error('the token id must be a whole number');
    const receipt = await sendTx(tx.create(CONFIG.factory, { provider: offer.provider, operator: offer.operator, tokenId: f.tokenId.trim(), providerBps: offer.providerBps, deviceKey: offer.deviceKey }),
      'Create the vault', `A vault for seat #${f.tokenId.trim()} with host ${short(offer.provider)}: you keep ${100 - offer.providerBps / 100}%, the host receives ${offer.providerBps / 100}%. No daily fee, no deposit.`);
    if (!receipt) return;
    const created = decodeLogs(receipt).find((e) => e.name === 'VaultCreated' && lower(e.address) === lower(CONFIG.factory));
    if (!created) throw new Error('no VaultCreated event in the receipt');
    store.vault = created.args.vault; store.artifactText = null; save();
    log(`vault ${store.vault} created`);
    toast('Vault created. Send its address to your host.');
    await refresh();
  }),
  deposit: () => sendTx(tx.depositSeat(CONFIG.collection, wallet.address, vault.address, vault.tokenId), 'Move my NFT into the vault', 'Your NFT moves into its vault in one safe transfer. You can take it back at any time.'),
  syncHeld: () => sendTx(tx.syncHeld(vault.address), 'Record the NFT as held', 'The NFT is already in the vault; this records it so pairing can be approved.'),
  'pairing-offer': () => showForm("Paste the host's pairing string", [['offer', 'seatpair1:…', '', true]], async (f) => {
    const a = decodeOffer(PAIRING_PREFIX, f.offer);
    const problems = checkPairingOfferAgainstVault(a, vault, CONFIG);
    if (problems.length) throw new Error(problems.join('; '));
    const digest = await workerAuthorizationDigest(wallet.client, vault.address, a.message.deviceKey, a.message.nonce, a.message.expiresAt);
    if (lower(digest) !== lower(a.digest)) throw new Error("the string's digest does not match what this vault computes");
    store.artifactText = f.offer.trim(); save();
    log(`pairing string ${a.code} accepted; approve before ${new Date(a.message.expiresAt * 1000).toISOString()}`);
    await refresh();
  }),
  approvePairing: () => sendTx(tx.approvePairing(vault.address, artifact.message.nonce, artifact.message.expiresAt, artifact.message.relayOrigin), 'Approve the pairing', `Approve exactly this pairing (code ${artifact.code}) for your host's device. It must be mined before ${new Date(artifact.message.expiresAt * 1000).toLocaleTimeString()}.`, { pending: true }),
  registerAgent: () => sendTx(tx.registerAgent(vault.address, artifact.intent.data), 'Register the agent', "IMD's registration for this seat, sent through the vault. The page checked it names this seat and IMD's registrar."),
  claim: () => sendTx(tx.claim(vault.address), 'Claim my rewards', 'Sends your share of the rewards in the vault to your wallet.'),
  withdraw: () => showForm('Take my NFT back', [['to', 'Send the NFT to', wallet.address || '']], (f) => sendTx(tx.withdraw(vault.address, f.to.trim()), 'Take my NFT back', 'Ends the agreement and returns the NFT in one transaction. Rewards already here stay claimable.')),
  selectVault: () => showForm('Open an agreement', [['address', 'Vault address', store.vault || '']], async (f) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(f.address.trim())) throw new Error('not an address');
    const v = await readVault(wallet.client, f.address.trim());
    if (lower(v.collection) !== lower(CONFIG.collection)) throw new Error('that vault is for another collection');
    store.vault = f.address.trim(); store.artifactText = null; save();
    await refresh();
  }),
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
    : (store.vault ? `vault ${esc(store.vault)} (connect the wallet to read it)` : '<button class="link" id="changeVault">open an existing agreement</button>');
  $('changeVault')?.addEventListener('click', actions.selectVault);

  const main = $('main');
  const notes = [];
  if (lower(c.factory) === ZERO) notes.push('<div class="note error">This page has no factory address configured yet; nothing can be created until the contracts are deployed.</div>');
  if (!wallet.address) {
    main.innerHTML = `<span class="eyebrow">ONE NFT / ONE HOST</span><h1>Your NFT, hosted</h1><p class="lead">Hand your seat to a host who runs the worker. Rewards split by a fixed share, no fee, no deposit, and you can take the NFT back at any time.</p><button class="button primary" id="connectMain">Connect wallet</button><p class="hint">Reads go through your wallet's own connection; nothing is sent anywhere until you approve a transaction.</p>`;
    $('connectMain').onclick = connect;
  } else if (!onChain()) {
    main.innerHTML = `<span class="eyebrow">ONE NFT / ONE HOST</span><h1>Wrong network</h1><p class="lead">Switch your wallet to chain ${c.chainId}.</p><button class="button primary" id="switchMain">Switch network</button>`;
    $('switchMain').onclick = switchChain;
  } else if (!vault) {
    main.innerHTML = `<span class="eyebrow">ONE NFT / ONE HOST</span><h1>Start</h1><p class="lead">Ask your host for their hosting offer string, then create the vault for your seat. Or open an agreement that already exists.</p><button class="button primary" data-action="create" ${lower(c.factory) === ZERO ? 'disabled' : ''}>Create the vault</button><div class="actions"><button class="button small" data-action="selectVault">Open an existing agreement</button></div>`;
  } else {
    const d = derive({ vault, imdSeat, artifact, pendingHashes: pendingFor(vault.address), agentReusable });
    const mine = r === 'owner' ? d.owner : r === 'host' ? d.host : [];
    const primary = mine.find((a) => !a.passive && !a.secondary);
    const waiting = mine.find((a) => a.passive);
    const secondary = mine.filter((a) => a.secondary);
    const titles = { create: 'Start', deposit: 'Move your NFT in', pair: 'Approve the pairing', register: 'Register the agent', hosted: 'Hosted', exit: vault.ended && lower(vault.seatOwner) !== lower(vault.address) ? 'Agreement ended' : 'Take your NFT back' };
    const seatIn = lower(vault.seatOwner) === lower(vault.address);
    const imdLine = imdSeat ? `IMD lists this seat${imdSeat.agentId ? ` with agent <b>${esc(imdSeat.agentId)}</b>` : ' without an agent yet'}${imdSeat.accepted !== undefined ? `, <b>${esc(imdSeat.accepted)}</b> accepted jobs${imdSeat.working ? ', working now' : ''}` : ''}.` : 'IMD does not list this seat yet.';
    main.innerHTML = `<span class="eyebrow">ONE NFT / ONE HOST</span><h1>${esc(titles[d.step])}</h1>
      <span class="status${d.step === 'hosted' ? '' : ' warn'}">${esc(d.step === 'hosted' ? 'HOSTED' : d.step.toUpperCase())}</span>
      <div class="split"><span>NFT <b>#${esc(vault.tokenId)}</b></span><span>Owner keeps <b>${100 - vault.providerBps / 100}%</b></span><span>Host receives <b>${vault.providerBps / 100}%</b></span><span>No daily fee</span></div>
      ${primary ? `<button class="button primary" data-action="${esc(primary.id)}" ${busy ? 'disabled' : ''}>${esc(primary.label)}</button>${primary.hint ? `<p class="hint">${esc(primary.hint)}</p>` : ''}` : waiting ? `<div class="wait">${esc(waiting.label)}</div>` : (r === 'viewer' ? '<div class="wait">Connect the owner\'s or the host\'s wallet to act.</div>' : '<div class="wait">Nothing to do right now.</div>')}
      ${artifact && d.step === 'pair' ? `<p class="hint">Pairing code ${esc(artifact.code)} · approve before ${esc(new Date(artifact.message.expiresAt * 1000).toLocaleTimeString())}</p>` : ''}
      <p class="imd">${imdLine}</p>
      ${secondary.length ? `<div class="actions">${secondary.map((a) => `<button class="button small" data-action="${esc(a.id)}" ${busy ? 'disabled' : ''}>${esc(a.label)}</button>`).join('')}</div>` : ''}`;
    for (const n of d.notes) notes.push(`<div class="note">${esc(n)}</div>`);
    $('details').innerHTML = `<dl>${[
      ['NFT holder', esc(vault.seatOwner), seatIn ? 'ok' : ''], ['recorded as held', vault.held ? 'yes' : 'no', vault.held ? 'ok' : ''], ['agreement', vault.ended ? 'ended' : 'open', vault.ended ? '' : 'ok'],
      ['owner', esc(vault.owner)], ['host', esc(vault.provider)], ['operator', esc(vault.operator)], ['device key', esc(vault.deviceKey)],
      ['approved pairing', vault.approvedUntil > Date.now() / 1000 ? `${esc(vault.approvedDigest)} until ${esc(new Date(vault.approvedUntil * 1000).toISOString())}` : 'none live'],
      ['unresolved approvals', pendingFor(vault.address).length ? esc(pendingFor(vault.address).join(', ')) : 'none'],
      ['rewards in the vault', `${esc(formatUnits(vault.rewardBalance, c.rewardDecimals))} ${esc(c.rewardSymbol)} (unsettled ${esc(formatUnits(vault.pending, c.rewardDecimals))})`],
      ['owner claimable', `${esc(formatUnits(vault.claimableOwner, c.rewardDecimals))} ${esc(c.rewardSymbol)}`], ['host claimable', `${esc(formatUnits(vault.claimableProvider, c.rewardDecimals))} ${esc(c.rewardSymbol)}`],
      ['pairing string', store.artifactText ? `<span class="offer">${esc(store.artifactText)}</span>` : '—'],
    ].map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd class="${cls || ''}">${v}</dd>`).join('')}</dl>
      <h2>Steps</h2><p class="hint">${d.statuses.map((s) => `${s.status === 'done' ? '✓' : s.status === 'current' ? '●' : '○'} ${esc(s.title)}`).join(' · ')}</p>
      <h2>History (this browser)</h2><ol class="log">${store.log.slice().reverse().map((l) => `<li><time>${esc(l.at.replace('T', ' ').slice(0, 19))}</time>${esc(l.text)}</li>`).join('')}</ol>`;
  }
  $('notes').innerHTML = notes.join('');
  document.querySelectorAll('[data-action]').forEach((b) => { b.onclick = () => actions[b.dataset.action]?.(); });
}

$('resetBtn').onclick = () => { if (confirm('Forget the vault, pasted strings and history kept in this browser? Nothing on chain changes.')) { localStorage.removeItem(KEY); location.reload(); } };
render();
if (window.ethereum && store.vault) connect().catch(() => render());
setInterval(() => { if (!busy && onChain() && store.vault) refresh(); }, 6000);
