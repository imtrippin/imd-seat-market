// One agreement's session on the loopback server: the selected vault, the chain snapshot, IMD's view, the pairing
// artifact, transactions the wallet sent, and a log both roles read. Persisted to data/session.json so a restart
// continues where it was. The only secret the session can hold is the host's operator key, from the environment,
// used for one thing: signing the pairing digest.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeClient, readVault, readFactory, listVaults, tx as txFor, waitReceipt, decodeLogs, isValidSignature, workerAuthorizationDigest, formatUnits } from './chain.js';
import { ImdApi } from './imd.js';
import { validatePairing, buildMessage, typedData, walletTypedData, completionBody, validateArtifact, expiryProblems, parseExpiry, encodeOffer, decodeOffer, validateHostingOffer, HOSTING_PREFIX, PAIRING_PREFIX } from './pairing.js';
import { derive } from './steps.js';
import { Setup } from './setup.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SELECTOR_REGISTER = '0xb68ca002';
const SELECTOR_REGISTER_META = '0x1fd8046a';

export class Session {
  constructor(config, { dataDir, operatorKey = null, fetchImpl = fetch, now = () => Date.now(), log = () => {} } = {}) {
    this.config = config;
    this.client = makeClient(config.rpcUrl);
    this.imd = new ImdApi(config.imdApi, { fetchImpl });
    this.dataDir = dataDir;
    this.now = now;
    this.print = log;
    this.operator = operatorKey ? privateKeyToAccount(operatorKey) : null;
    this.state = {
      vault: null, hostingOffer: null, pairing: { phase: 'none' }, registration: {}, txs: [], log: [],
    };
    this.snapshot = null;
    this.imdView = { standing: null, standingAt: 0, standingStatus: null, workerStanding: null, pairStatus: null, lastError: null };
    this.factory = null;
    this.error = null;
    this.refreshing = false;
    this.setup = new Setup(this);
    this.load();
  }

  // ---------------------------------------------------------------- persistence

  file() { return join(this.dataDir, 'session.json'); }

  load() {
    try {
      if (this.dataDir && existsSync(this.file())) {
        const saved = JSON.parse(readFileSync(this.file(), 'utf8'));
        if (saved && typeof saved === 'object') this.state = { ...this.state, ...saved };
      }
    } catch (e) { this.note('system', `could not read the saved session: ${e.message}`); }
  }

  save() {
    if (!this.dataDir) return;
    try { mkdirSync(this.dataDir, { recursive: true }); writeFileSync(this.file(), JSON.stringify(this.state, null, 1)); } catch (e) { this.print(`save failed: ${e.message}`); }
  }

  note(who, text) {
    const entry = { at: new Date(this.now()).toISOString(), who, text };
    this.state.log.push(entry);
    if (this.state.log.length > 400) this.state.log.splice(0, this.state.log.length - 400);
    this.print(`[${who}] ${text}`);
    this.save();
  }

  // ---------------------------------------------------------------- reads

  async refresh() {
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = (async () => {
      try {
        if (!this.factory) this.factory = await readFactory(this.client, this.config.factory);
        const selected = this.state.vault;
        if (selected) {
          const snapshot = await readVault(this.client, selected);
          if (this.state.vault === selected) this.snapshot = snapshot;
        }
        this.error = null;
      } catch (e) { this.error = `chain read failed: ${e.shortMessage || e.message}`; }
    })();
    try { await this.refreshTask; } finally { this.refreshTask = null; }
  }

  async refreshImd({ force = false } = {}) {
    if (!this.snapshot) return;
    const busy = this.state.pairing.phase === 'completed' || this.state.registration.txHash;
    const every = busy ? Math.min(this.config.imdPollMs, 8000) : this.config.imdPollMs;
    if (!force && this.now() - this.imdView.standingAt < every) return;
    this.imdView.standingAt = this.now();
    try {
      const r = await this.imd.seatStanding(this.snapshot.tokenId);
      this.imdView.standingStatus = r.status;
      this.imdView.standing = r.ok ? r.json : null;
      this.imdView.lastError = r.ok || r.status === 404 ? null : `standing ${r.status}`;
      if (this.state.pairing.code && this.state.pairing.completed && !this.state.pairing.enrolledSeen) {
        const p = await this.imd.pairingStatus(this.state.pairing.code);
        this.imdView.pairStatus = p.json;
        if (p.ok && p.json && p.json.enrolled) { this.state.pairing.enrolledSeen = true; this.note('imd', `pairing code ${this.state.pairing.code} shows enrolled for token ${p.json.tokenId ?? this.snapshot.tokenId}`); }
      }
    } catch (e) { this.imdView.lastError = `IMD unreachable: ${e.message}`; }
  }

  view() {
    const nowSec = Math.floor(this.now() / 1000);
    const snap = {
      vault: this.snapshot, imd: this.imdView, pairing: this.state.pairing, registration: this.state.registration,
      hostingOffer: this.state.hostingOffer, pairingOfferImported: !!(this.state.pairing.artifact),
    };
    const derived = this.snapshot || !this.state.vault ? derive(snap, nowSec) : { step: 'loading', statuses: [], owner: [], host: [], notes: [] };
    const c = this.config;
    return {
      config: { chainId: c.chainId, factory: c.factory, collection: c.collection, rewardToken: c.rewardToken, registrar: c.registrar, relayOrigin: c.relayOrigin, imdApi: c.imdApi, explorer: c.explorer, rewardSymbol: c.rewardSymbol, rewardDecimals: c.rewardDecimals, operatorOnServer: !!this.operator, operatorAddress: this.operator ? this.operator.address : null },
      factory: this.factory,
      vault: this.snapshot ? { ...this.snapshot, rewardBalanceText: formatUnits(this.snapshot.rewardBalance, c.rewardDecimals), pendingText: formatUnits(this.snapshot.pending, c.rewardDecimals), claimableOwnerText: formatUnits(this.snapshot.claimableOwner, c.rewardDecimals), claimableProviderText: formatUnits(this.snapshot.claimableProvider, c.rewardDecimals) } : null,
      selectedVault: this.state.vault,
      hostingOffer: this.state.hostingOffer,
      pairing: this.publicPairing(),
      registration: this.state.registration,
      imd: this.imdView,
      txs: this.state.txs.slice(-30),
      log: this.state.log.slice(-80),
      derived,
      error: this.error,
      now: this.now(),
      setup: this.setup.view(),
    };
  }

  publicPairing() {
    const p = this.state.pairing;
    return { phase: p.phase, code: p.code || null, artifact: p.artifact || null, offer: p.offer || null, codeExpiresAt: p.codeExpiresAt || null, completed: !!p.completed, enrolledSeen: !!p.enrolledSeen, completion: p.completion || null, pendingHashes: p.pendingHashes || [] };
  }

  // ---------------------------------------------------------------- selection

  async selectVault(address) {
    this.setup.clear();
    if (!ADDR.test(String(address || ''))) throw new Error('not an address');
    const vault = getAddress(address);
    const snap = await readVault(this.client, vault);
    if (snap.collection.toLowerCase() !== this.config.collection.toLowerCase()) throw new Error('that vault is for another collection');
    this.state.vault = vault;
    this.snapshot = snap;
    this.state.pairing = { phase: 'none' };
    this.state.registration = {};
    this.imdView = { standing: null, standingAt: 0, standingStatus: null, workerStanding: null, pairStatus: null, lastError: null };
    this.note('console', `vault ${vault} selected (seat ${snap.tokenId}, owner ${snap.owner}, host ${snap.provider})`);
    await this.refreshImd({ force: true });
    return snap;
  }

  async vaults(filter = {}) {
    const rows = await listVaults(this.client, this.config.factory);
    return rows.filter((r) => (!filter.owner || r.owner.toLowerCase() === filter.owner.toLowerCase()) && (!filter.provider || r.provider.toLowerCase() === filter.provider.toLowerCase()));
  }

  reset() {
    this.setup.clear();
    this.state = { vault: null, hostingOffer: null, pairing: { phase: 'none' }, registration: {}, txs: [], log: [] };
    this.snapshot = null;
    this.imdView = { standing: null, standingAt: 0, standingStatus: null, workerStanding: null, pairStatus: null, lastError: null };
    this.note('console', 'session reset');
  }

  // ---------------------------------------------------------------- hosting offer (host builds, owner imports)

  buildHostingOffer({ provider, operator, deviceKey, providerBps }) {
    const offer = { v: 1, provider: getAddress(provider), operator: getAddress(operator), deviceKey: '0x' + String(deviceKey).replace(/^0x/, '').toLowerCase(), providerBps: Number(providerBps), chainId: this.config.chainId, relayOrigin: this.config.relayOrigin, collection: this.config.collection };
    const problems = validateHostingOffer(offer, { chain: this.config.chainId, relay: this.config.relayOrigin });
    if (problems.length) throw new Error(problems.join('; '));
    return { offer, text: encodeOffer(HOSTING_PREFIX, offer) };
  }

  importHostingOffer(text) {
    const offer = decodeOffer(HOSTING_PREFIX, text);
    const problems = validateHostingOffer(offer, { chain: this.config.chainId, relay: this.config.relayOrigin });
    if (problems.length) throw new Error(problems.join('; '));
    this.state.hostingOffer = offer;
    this.note('owner', `hosting offer imported: host ${offer.provider}, operator ${offer.operator}, host share ${offer.providerBps / 100}%`);
    return offer;
  }

  // ---------------------------------------------------------------- transactions (built here, signed in the wallet)

  buildTx(action, params = {}) {
    const c = this.config;
    const v = this.snapshot;
    const need = () => { if (!v) throw new Error('select or create a vault first'); return v; };
    switch (action) {
      case 'create': {
        const o = this.state.hostingOffer || params;
        const problems = validateHostingOffer({ ...o, chainId: c.chainId, relayOrigin: c.relayOrigin }, { chain: c.chainId, relay: c.relayOrigin });
        if (problems.length) throw new Error(problems.join('; '));
        if (!/^\d+$/.test(String(params.tokenId ?? ''))) throw new Error('tokenId must be a decimal seat id');
        return { role: 'owner', ...txFor.create(c.factory, { provider: o.provider, operator: o.operator, tokenId: params.tokenId, providerBps: o.providerBps, deviceKey: o.deviceKey }) };
      }
      case 'approveSeat': return { role: 'owner', ...txFor.approveSeat(need().collection, v.address, v.tokenId) };
      case 'deposit': return { role: 'owner', ...txFor.deposit(need().address) };
      case 'syncHeld': return { role: 'owner', ...txFor.syncHeld(need().address) };
      case 'approvePairing': {
        need();
        const a = this.state.pairing.artifact;
        if (!a) throw new Error('import the host\'s pairing offer first');
        const problems = [...validateArtifact(a), ...expiryProblems(a, this.now())];
        const remaining = Math.min(Number(a.codeExpiresAt), a.message.expiresAt * 1000) - this.now();
        if (!Number.isFinite(remaining) || remaining < 60_000) problems.push('Less than one minute remains; let this attempt expire and start again before paying for an approval');
        if (problems.length) throw new Error(problems.join('; '));
        return { role: 'owner', ...txFor.approvePairing(v.address, a.message.nonce, a.message.expiresAt, a.message.relayOrigin), digest: a.digest };
      }
      case 'revokePairing': return { role: 'owner', ...txFor.revokePairing(need().address) };
      case 'registerAgent': {
        need();
        const intent = this.state.registration.intent;
        if (!intent) throw new Error('fetch IMD\'s register-intent first');
        return { role: 'owner', ...txFor.registerAgent(v.address, intent.data) };
      }
      case 'settle': return { role: 'any', ...txFor.settle(need().address) };
      case 'claim': return { role: 'party', ...txFor.claim(need().address) };
      case 'end': return { role: 'party', ...txFor.end(need().address) };
      case 'withdraw': {
        need();
        const to = params.to || v.owner;
        return { role: 'owner', ...txFor.withdraw(v.address, to) };
      }
      default: throw new Error(`unknown action ${action}`);
    }
  }

  async txSent(action, hash, from) {
    if (!HASH.test(String(hash || ''))) throw new Error('bad transaction hash');
    const entry = { action, hash, from: from || null, status: 'pending', at: new Date(this.now()).toISOString() };
    this.state.txs.push(entry);
    if (action === 'approvePairing') {
      const list = (this.state.pairing.pendingHashes ||= []);
      if (!list.includes(hash)) list.push(hash); // a fresh attempt must not start over an unresolved approval
    }
    this.note(from ? this.roleOf(from) : 'wallet', `${action} sent: ${hash}`);
    this.track(entry).catch((e) => { entry.status = 'error'; entry.error = e.message; this.note('console', `${action} ${hash}: ${e.message}`); });
    return entry;
  }

  roleOf(address) {
    const v = this.snapshot;
    const a = String(address).toLowerCase();
    if (v && a === v.owner.toLowerCase()) return 'owner';
    if (v && a === v.provider.toLowerCase()) return 'host';
    if (v && a === v.operator.toLowerCase()) return 'operator';
    if (!v && this.state.hostingOffer && a === this.state.hostingOffer.provider.toLowerCase()) return 'host';
    return 'wallet';
  }

  async track(entry) {
    const receipt = await waitReceipt(this.client, entry.hash);
    entry.status = receipt.status === 'success' ? 'confirmed' : 'reverted';
    entry.block = Number(receipt.blockNumber);
    if (entry.action === 'approvePairing' && this.state.pairing.pendingHashes) {
      this.state.pairing.pendingHashes = this.state.pairing.pendingHashes.filter((h) => h !== entry.hash);
    }
    const events = decodeLogs(receipt);
    entry.events = events;
    this.note('chain', `${entry.action} ${entry.status} in block ${entry.block}${events.length ? ': ' + events.map((e) => e.name).join(', ') : ''}`);
    if (entry.status !== 'confirmed') { this.save(); return; }
    const created = events.find((e) => e.name === 'VaultCreated' && e.address.toLowerCase() === this.config.factory.toLowerCase());
    if (created) await this.selectVault(created.args.vault);
    const registered = events.find((e) => e.name === 'AgentRegistered');
    if (registered) {
      this.state.registration.agentId = String(registered.args.agentId);
      this.state.registration.txHash = entry.hash;
      this.note('chain', `agent ${this.state.registration.agentId} registered for seat ${this.snapshot?.tokenId}`);
      await this.bind();
    }
    await this.refresh();
    this.save();
  }

  // ---------------------------------------------------------------- pairing

  async startPairing(deviceKey, allowed = () => true) {
    if (this.startingPairing) throw new Error('A pairing request is already in progress');
    this.startingPairing = true;
    try { return await this.startReadyPairing(deviceKey, allowed); } finally { this.startingPairing = false; }
  }

  async startReadyPairing(deviceKey, allowed) {
    await this.refresh();
    if (this.error) throw new Error(this.error);
    const v = this.snapshot;
    if (!v) throw new Error('select the vault first');
    if (!v.held || v.ended) throw new Error('the seat must be recorded as held and the agreement open');
    const key = '0x' + String(deviceKey || v.deviceKey).replace(/^0x/, '').toLowerCase();
    if (key !== v.deviceKey.toLowerCase()) throw new Error(`that device key is not the vault's (${v.deviceKey}); the owner can change it with setDeviceKey`);
    for (const hash of this.state.pairing.pendingHashes || []) {
      try { await this.client.getTransactionReceipt({ hash }); } catch { throw new Error('An approval transaction is unresolved; check the wallet before starting again'); }
    }
    // With a joined setup room the attempt is reserved there and the offer is shared through it; without one the
    // host hands the owner the offer string by any channel. Both paths run the same local checks.
    const inRoom = !!this.setup.auth;
    let attemptId = null;
    if (inRoom) {
      const reservation = await this.setup.act('begin');
      attemptId = reservation.room.attempt.id;
    }
    if (!allowed() || v.address !== this.state.vault) throw new Error('Setup was cancelled or the selected vault changed');
    const r = await this.imd.startPairing(key);
    if (!r.ok) throw new Error(`IMD /pair/start ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    const p = { ...r.json, deviceKey: r.json.deviceKey || key.slice(2) };
    const expect = { relay: this.config.relayOrigin, chain: this.config.chainId, collection: this.config.collection, token: v.tokenId, vault: v.address };
    const problems = validatePairing(p, expect, this.now());
    if (problems.length) throw new Error(`pairing response rejected: ${problems.join('; ')}`);
    const codeExpiresAt = p.expiresAt !== undefined ? parseExpiry(p.expiresAt) : null;
    if (!Number.isFinite(codeExpiresAt) || codeExpiresAt - this.now() < 60_000) throw new Error('IMD did not supply a pairing deadline with enough time remaining');
    // the signature expiry: 10 minutes, or the code's own life when it is shorter, never past the vault's window
    const sigExp = Math.floor(this.now() / 1000) + 600;
    const expiresAt = codeExpiresAt ? Math.min(sigExp, Math.floor(codeExpiresAt / 1000)) : sigExp;
    const message = buildMessage(p, expect, expiresAt);
    const digest = await workerAuthorizationDigest(this.client, v.address, message.deviceKey, message.nonce, message.expiresAt);
    const artifact = { code: p.code, vault: v.address, collection: this.config.collection, chain: this.config.chainId, message, digest, codeExpiresAt };
    const offer = encodeOffer(PAIRING_PREFIX, artifact);
    this.state.pairing = { phase: 'offered', code: p.code, artifact, offer, codeExpiresAt, completed: false, enrolledSeen: false };
    this.save();
    if (inRoom) await this.setup.act('offer', { attemptId, offer });
    this.note('host', `pairing ${p.code} started for device ${key.slice(0, 10)}…; the owner must approve digest ${digest.slice(0, 10)}… before ${new Date(expiresAt * 1000).toISOString()}`);
    return this.publicPairing();
  }

  async importPairingOffer(text) {
    const v = this.snapshot;
    if (!v) throw new Error('select the vault first');
    const artifact = decodeOffer(PAIRING_PREFIX, text);
    const problems = validateArtifact(artifact);
    if (artifact.vault && artifact.vault.toLowerCase() !== v.address.toLowerCase()) problems.push('the offer is for another vault');
    if (artifact.message && artifact.message.deviceKey !== v.deviceKey.toLowerCase()) problems.push('the offer\'s device key is not the vault\'s');
    if (artifact.message && String(artifact.message.tokenId) !== String(v.tokenId)) problems.push('the offer\'s token is not the vault\'s seat');
    if (artifact.message && artifact.message.relayOrigin !== this.config.relayOrigin) problems.push('the offer\'s relay is not the agreed one');
    if (artifact.chain !== this.config.chainId) problems.push('the offer is for another chain');
    if (artifact.message && artifact.message.expiresAt > Math.floor(this.now() / 1000) + 3600) problems.push('the offer\'s expiry is beyond the vault\'s one-hour window');
    problems.push(...(artifact.message ? expiryProblems(artifact, this.now()) : []));
    if (problems.length) throw new Error(problems.join('; '));
    const digest = await workerAuthorizationDigest(this.client, v.address, artifact.message.deviceKey, artifact.message.nonce, artifact.message.expiresAt);
    if (digest.toLowerCase() !== String(artifact.digest || '').toLowerCase()) throw new Error('the offer\'s digest does not match what this vault computes');
    this.state.pairing = { phase: 'offered', code: artifact.code, artifact: { ...artifact, digest }, offer: text.trim(), codeExpiresAt: artifact.codeExpiresAt || null, completed: false, enrolledSeen: false };
    this.note('owner', `pairing offer ${artifact.code} imported; approve digest ${digest.slice(0, 10)}… before ${new Date(artifact.message.expiresAt * 1000).toISOString()}`);
    return this.publicPairing();
  }

  pairingTypedData() {
    const a = this.state.pairing.artifact;
    if (!a) throw new Error('no pairing in progress');
    return walletTypedData(a);
  }

  /// The host completes: sign with the operator key on the server, or accept a signature made in the operator's
  /// wallet; either way the vault must answer valid before anything is sent to IMD.
  async completePairing(signature = null, allowed = () => true) {
    if (this.completingPairing) throw new Error('Pairing completion is already in progress');
    this.completingPairing = true;
    try { return await this.completeApprovedPairing(signature, allowed); } finally { this.completingPairing = false; }
  }

  async completeApprovedPairing(signature, allowed) {
    const v = this.snapshot;
    const a = this.state.pairing.artifact;
    if (!v || !a) throw new Error('no pairing in progress');
    const problems = [...validateArtifact(a), ...expiryProblems(a, this.now())];
    if (problems.length) throw new Error(problems.join('; '));
    await this.refresh();
    if (this.error) throw new Error(this.error);
    if (!allowed() || v.address !== this.state.vault) throw new Error('Setup was cancelled or the selected vault changed');
    if (String(this.snapshot.approvedDigest).toLowerCase() !== String(a.digest).toLowerCase()) throw new Error('the vault has not approved this digest yet (wait for the owner\'s approval to be mined)');
    if (this.snapshot.approvedUntil <= Math.floor(this.now() / 1000)) throw new Error('the approval has expired');
    let sig = signature;
    if (!sig) {
      if (!this.operator) throw new Error('no operator key on this console: sign the typed data in the operator\'s wallet and post the signature');
      if (this.operator.address.toLowerCase() !== v.operator.toLowerCase()) throw new Error(`the console's operator key (${this.operator.address}) is not the vault's operator (${v.operator})`);
      sig = await this.operator.signTypedData(typedData(a));
    }
    if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('signature must be 65 bytes of hex');
    const signer = await recoverTypedDataAddress({ ...typedData(a), signature: sig });
    if (![v.operator.toLowerCase(), v.owner.toLowerCase()].includes(signer.toLowerCase())) throw new Error(`the signature recovers to ${signer}, not the operator or the owner`);
    const digest = hashTypedData(typedData(a));
    if (digest.toLowerCase() !== String(a.digest).toLowerCase()) throw new Error('typed-data digest mismatch');
    if (!(await isValidSignature(this.client, v.address, digest, sig))) throw new Error('the vault does not accept this signature (expired, wrong chain, or not the approved digest)');
    const late = expiryProblems(a, this.now());
    if (late.length) throw new Error(late.join('; '));
    if (!allowed() || v.address !== this.state.vault) throw new Error('Setup was cancelled or the selected vault changed');
    const body = completionBody(a, sig);
    const r = await this.imd.completePairing(body);
    this.state.pairing.completion = { status: r.status, response: r.json, at: new Date(this.now()).toISOString() };
    if (!r.ok) { this.note('host', `IMD /pair/complete ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`); this.save(); throw new Error(`IMD refused the completion (${r.status})`); }
    this.state.pairing.phase = 'completed';
    this.state.pairing.completed = true;
    this.note('host', `pairing ${a.code} completed on IMD: ${JSON.stringify(r.json).slice(0, 200)}`);
    await this.refreshImd({ force: true });
    return this.publicPairing();
  }

  // ---------------------------------------------------------------- registration

  async fetchRegisterIntent() {
    const v = this.snapshot;
    if (!v) throw new Error('select the vault first');
    const r = await this.imd.registerIntent(v.tokenId);
    if (!r.ok) throw new Error(`IMD register-intent ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    const intent = r.json || {};
    const problems = [];
    if (String(intent.to || '').toLowerCase() !== this.config.registrar.toLowerCase()) problems.push(`intent targets ${intent.to}, not the pinned registrar ${this.config.registrar}`);
    if (Number(intent.chainId) !== this.config.chainId) problems.push(`intent chainId ${intent.chainId} is not ${this.config.chainId}`);
    const data = String(intent.data || '');
    if (!/^0x[0-9a-fA-F]+$/.test(data) || data.length < 2 + 8 + 192) problems.push('intent calldata is too short');
    else {
      const selector = data.slice(0, 10).toLowerCase();
      if (selector !== SELECTOR_REGISTER && selector !== SELECTOR_REGISTER_META) problems.push(`intent selector ${selector} is not a register function`);
      const words = data.slice(10);
      const standard = BigInt('0x' + words.slice(0, 64));
      const tokenContract = '0x' + words.slice(64 + 24, 128);
      const tokenId = BigInt('0x' + words.slice(128, 192));
      if (standard !== 0n) problems.push('intent standard is not ERC-721 (0)');
      if (tokenContract.toLowerCase() !== this.config.collection.toLowerCase()) problems.push(`intent names collection ${tokenContract}, not ${this.config.collection}`);
      if (tokenId.toString() !== String(v.tokenId)) problems.push(`intent names token ${tokenId}, not this vault's seat ${v.tokenId}`);
    }
    if (problems.length) throw new Error(`register-intent rejected: ${problems.join('; ')}`);
    this.state.registration = { ...this.state.registration, intent: { to: intent.to, data, chainId: Number(intent.chainId), agentURI: intent.agentURI || null }, intentAt: new Date(this.now()).toISOString() };
    this.note('owner', `register-intent fetched for seat ${v.tokenId}: ${data.slice(0, 10)}… to ${intent.to}${intent.agentURI ? ` (agentURI ${intent.agentURI})` : ''}`);
    this.save();
    return this.state.registration;
  }

  async bind() {
    const v = this.snapshot;
    const reg = this.state.registration;
    if (!v || !reg.agentId) throw new Error('no registered agent to bind');
    const r = await this.imd.bind(v.tokenId, reg.agentId, reg.txHash);
    reg.bindResponse = { status: r.status, response: r.json, at: new Date(this.now()).toISOString() };
    if (r.ok) {
      reg.bound = !(r.json && r.json.pending);
      this.note('imd', reg.bound ? `IMD bound agent ${reg.agentId} to seat ${v.tokenId}` : `IMD accepted the bind as pending (chain not yet visible); retry later`);
    } else {
      this.note('imd', `IMD /agents/bind ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    }
    this.save();
    await this.refreshImd({ force: true });
    return reg;
  }
}
