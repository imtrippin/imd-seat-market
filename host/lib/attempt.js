// One pairing attempt for one vault, run on the host's machine: prove the vault is the factory's, ask IMD for a
// code, hand the owner the pairing string, wait for the owner's exact approval on chain, complete with the operator
// key, then bind the agent on IMD (reusing an existing agent when the registrar says this vault controls an agent
// bound to exactly this seat, or the one the owner registers). A small record survives restarts; an ambiguous
// completion (the answer was lost) is reconciled with IMD before anything is sent again.
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { readVault, readFactory, isFactoryVault, vaultControlsAgent, isValidSignature, workerAuthorizationDigest, agentRegisteredSince } from './chain.js';
import { validatePairing, buildMessage, typedData, completionBody, validateArtifact, validateIntent, expiryProblems, parseExpiry, encodeOffer, PAIRING_PREFIX } from './pairing.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (a) => String(a || '').toLowerCase();

export class Attempt {
  /// store: { load(): record|null, save(record) }; operator: a viem account; log: (text) => void
  constructor({ config, client, imd, operator, store, vault, now = () => Date.now(), log = () => {}, pollMs = 3000 }) {
    Object.assign(this, { config, client, imd, operator, store, vault, now, log, pollMs });
    this.record = store.load() || null;
    this.cancelled = false;
  }

  cancel() { this.cancelled = true; }
  check() { if (this.cancelled) throw new Error('cancelled'); }
  save(patch) { this.record = { ...(this.record || {}), ...patch, updatedAt: new Date(this.now()).toISOString() }; this.store.save(this.record); }

  /// The vault must have been created by the pinned factory, be for this collection, registrar, reward token and
  /// relay, name this helper's operator, and hold the seat.
  async checkVault() {
    const c = this.config;
    if (!(await isFactoryVault(this.client, c.factory, this.vault, { fromBlock: c.factoryBlock || 0 }))) throw new Error('the address is not a vault created by the configured factory');
    const v = await readVault(this.client, this.vault);
    const f = await readFactory(this.client, c.factory);
    const same = (x, y) => lower(x) === lower(y);
    if (!same(v.collection, c.collection) || !same(v.collection, f.collection)) throw new Error('the vault is for another collection');
    if (!same(v.registrar, c.registrar) || !same(v.rewardToken, c.rewardToken)) throw new Error("the vault's registrar or reward token is not the configured one");
    if (v.relayOrigin !== c.relayOrigin) throw new Error("the vault's relay is not the configured one");
    if (!same(v.operator, this.operator.address)) throw new Error(`the vault's operator is ${v.operator}, not this helper's key ${this.operator.address}`);
    if (v.ended) throw new Error('the agreement has ended');
    if (!v.held) throw new Error('the owner has not moved the NFT into the vault yet');
    return v;
  }

  /// A usable existing agent: IMD's public view names one and the registrar says this vault controls an agent bound
  /// to exactly this seat. A registrar that cannot be read is an error, never "no agent" (that would pay for a
  /// second registration).
  async findReusableAgent(v) {
    const candidates = new Set();
    try { const st = await this.imd.seatStanding(v.tokenId); if (st.ok && st.json && st.json.agentId) candidates.add(String(st.json.agentId)); } catch { /* unknown */ }
    try { const sw = await this.imd.swarmSeat(v.tokenId); if (sw && sw.agentId) candidates.add(String(sw.agentId)); } catch { /* unknown */ }
    for (const id of candidates) {
      const ok = await vaultControlsAgent(this.client, this.config.registrar, id, v.address, this.config.collection, v.tokenId);
      if (ok === null) throw new Error(`IMD names agent ${id} for this seat but the registrar could not be read; retry before registering anew`);
      if (ok) return id;
    }
    return null;
  }

  /// Phase 1: ask IMD for a code and produce the pairing string. Refuses while an attempt is unresolved.
  async start() {
    const v = await this.checkVault();
    const r = this.record;
    if (r && r.artifact) {
      if (['completing', 'completed', 'bound'].includes(r.phase)) throw new Error(`an attempt is already past the approval (phase ${r.phase}); run resume`);
      if (r.phase === 'offered' && !expiryProblems(r.artifact, this.now()).length) throw new Error('an attempt is already in progress; run resume, or wait for it to expire');
    }
    const agentId = await this.findReusableAgent(v);
    let intent = null;
    if (!agentId) {
      const ri = await this.imd.registerIntent(v.tokenId);
      if (!ri.ok) throw new Error(`IMD register-intent ${ri.status}: ${JSON.stringify(ri.json).slice(0, 200)}`);
      intent = { to: ri.json.to, data: String(ri.json.data || ''), chainId: Number(ri.json.chainId), agentURI: ri.json.agentURI || null };
      const problems = validateIntent(intent, { registrar: this.config.registrar, chain: this.config.chainId, collection: this.config.collection, token: v.tokenId });
      if (problems.length) throw new Error(`register-intent rejected: ${problems.join('; ')}`);
    }
    const startBlock = Number(await this.client.getBlockNumber());
    this.check();
    const res = await this.imd.startPairing(v.deviceKey);
    if (!res.ok) throw new Error(`IMD /pair/start ${res.status}: ${JSON.stringify(res.json).slice(0, 200)}`);
    const p = { ...res.json, deviceKey: res.json.deviceKey || v.deviceKey.slice(2) };
    const expect = { relay: this.config.relayOrigin, chain: this.config.chainId, collection: this.config.collection, token: v.tokenId, vault: v.address };
    const problems = validatePairing(p, expect, this.now());
    if (problems.length) throw new Error(`pairing response rejected: ${problems.join('; ')}`);
    const codeExpiresAt = p.expiresAt !== undefined ? parseExpiry(p.expiresAt) : null;
    if (codeExpiresAt !== null && (!Number.isFinite(codeExpiresAt) || codeExpiresAt - this.now() < 60_000)) throw new Error('IMD did not supply a pairing deadline with enough time remaining');
    const sigExp = Math.floor(this.now() / 1000) + 600;
    const expiresAt = codeExpiresAt ? Math.min(sigExp, Math.floor(codeExpiresAt / 1000)) : sigExp;
    const message = buildMessage(p, expect, expiresAt);
    const digest = await workerAuthorizationDigest(this.client, v.address, message.deviceKey, message.nonce, message.expiresAt);
    const artifact = { code: p.code, vault: v.address, collection: this.config.collection, chain: this.config.chainId, message, digest, codeExpiresAt, intent, agentId };
    const bad = validateArtifact(artifact);
    if (bad.length) throw new Error(`artifact invalid: ${bad.join('; ')}`);
    const offer = encodeOffer(PAIRING_PREFIX, artifact);
    this.save({ phase: 'offered', vault: v.address, tokenId: v.tokenId, deviceKey: v.deviceKey, artifact, offer, startBlock, agentId, completion: null, bound: false });
    this.log(`pairing ${p.code} started; the owner must approve digest ${digest.slice(0, 10)}… before ${new Date(expiresAt * 1000).toISOString()}${agentId ? `; agent ${agentId} will be reused` : '; a registration will follow'}`);
    return offer;
  }

  /// Phase 2: wait for the owner's exact approval on chain (both clocks apply).
  async waitForApproval() {
    const a = this.record.artifact;
    for (;;) {
      this.check();
      const late = expiryProblems(a, this.now());
      if (late.length) { this.save({ phase: 'expired' }); throw new Error(late.join('; ')); }
      const v = await readVault(this.client, this.vault);
      if (v.ended) throw new Error('the agreement ended');
      if (lower(v.approvedDigest) === lower(a.digest) && v.approvedUntil > Math.floor(this.now() / 1000)) return v;
      await sleep(this.pollMs);
    }
  }

  /// IMD's standing for the seat names this attempt's device as the enrolment.
  async enrolledHere() {
    const st = await this.imd.seatStanding(this.record.tokenId);
    const e = st.ok && st.json ? st.json.enrollment : null;
    if (!e || !e.deviceKey) return false;
    return lower(String(e.deviceKey).replace(/^0x/, '')) === lower(this.record.artifact.message.deviceKey.slice(2));
  }

  /// Did a completion for this attempt already land on IMD? Checked from the code's status: consumed and enrolled
  /// for exactly this vault and seat means yes; consumed for anything else means the code was used by another
  /// attempt (stop, never re-post); not consumed means no. A code IMD no longer knows is checked through the
  /// seat's standing instead, and counts as failed only once the window has closed.
  async reconcileCompletion() {
    const a = this.record.artifact;
    const st = await this.imd.pairingStatus(a.code);
    if (st.status === 404) {
      if (await this.enrolledHere()) {
        this.save({ phase: 'completed', completion: { status: 'reconciled-standing', at: new Date(this.now()).toISOString() } });
        this.log(`pairing ${a.code} was completed earlier (IMD's standing names this device)`);
        return true;
      }
      if (expiryProblems(a, this.now()).length) { this.save({ phase: 'expired', completion: { status: 'unknown-code' } }); throw new Error(`IMD no longer knows pairing code ${a.code} and the window closed without an enrolment; start a new attempt`); }
      throw new Error(`IMD does not know pairing code ${a.code} (yet); retry resume`);
    }
    if (!st.ok || !st.json) throw new Error(`IMD did not answer the pairing status (${st.status}); retry resume`);
    const j = st.json;
    if (j.consumed) {
      if (j.enrolled && lower(j.wallet) === lower(this.vault) && String(j.tokenId) === String(this.record.tokenId)) {
        this.save({ phase: 'completed', completion: { status: 'reconciled', response: j, at: new Date(this.now()).toISOString() } });
        this.log(`pairing ${a.code} was completed earlier (reconciled from IMD's status)`);
        return true;
      }
      this.save({ phase: 'expired', completion: { status: 'consumed-elsewhere', response: j } });
      throw new Error(`pairing code ${a.code} was consumed but not for this vault and seat; start a new attempt`);
    }
    return false;
  }

  /// Phase 3: sign, check the vault accepts it, post the completion. Never posts twice: an unanswered post is
  /// reconciled with IMD's status before any retry.
  async complete() {
    const a = this.record.artifact;
    if (['completed', 'bound', 'done'].includes(this.record.phase)) return this.record.completion;
    if (this.record.phase === 'completing' && (await this.reconcileCompletion())) return this.record.completion;
    const late = expiryProblems(a, this.now());
    if (late.length) { this.save({ phase: 'expired' }); throw new Error(late.join('; ')); }
    const v = await readVault(this.client, this.vault);
    if (lower(v.approvedDigest) !== lower(a.digest)) throw new Error('the vault has not approved this digest');
    const sig = await this.operator.signTypedData(typedData(a));
    const signer = await recoverTypedDataAddress({ ...typedData(a), signature: sig });
    if (lower(signer) !== lower(v.operator)) throw new Error('the signature does not recover to the operator');
    const digest = hashTypedData(typedData(a));
    if (lower(digest) !== lower(a.digest)) throw new Error('typed-data digest mismatch');
    if (!(await isValidSignature(this.client, v.address, digest, sig))) throw new Error('the vault does not accept this signature (expired, wrong chain, or not the approved digest)');
    if (expiryProblems(a, this.now()).length) throw new Error('the window closed while checking; start again');
    this.check();
    this.save({ phase: 'completing' });
    let r;
    try { r = await this.imd.completePairing(completionBody(a, sig)); }
    catch (e) { throw new Error(`the completion was sent but no answer came back (${e.message}); run resume, which asks IMD what happened before doing anything else`); }
    if (!r.ok) {
      if (r.status === 409 && (await this.reconcileCompletion())) return this.record.completion;
      this.save({ phase: 'offered', completion: { status: r.status, response: r.json } });
      throw new Error(`IMD refused the completion (${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
    }
    this.save({ phase: 'completed', completion: { status: r.status, response: r.json, at: new Date(this.now()).toISOString() } });
    this.log(`pairing ${a.code} completed on IMD: ${JSON.stringify(r.json).slice(0, 200)}`);
    return this.record.completion;
  }

  /// Phase 4: bind the agent on IMD: the reused one now, or the one the owner registers (events backfilled from the
  /// attempt's start block, so a fast owner transaction is never missed).
  async bindAgent({ timeoutMs = 60 * 60_000 } = {}) {
    if (this.record.bound) return this.record.agentId;
    const t0 = this.now();
    let agentId = this.record.agentId || null;
    let txHash = null;
    while (!agentId) {
      this.check();
      const found = await agentRegisteredSince(this.client, this.vault, this.record.startBlock);
      if (found.length) { agentId = found[found.length - 1].agentId; txHash = found[found.length - 1].txHash; break; }
      if (this.now() - t0 > timeoutMs) throw new Error('no registration seen yet; run resume later (the pairing itself is done)');
      await sleep(this.pollMs);
    }
    this.check();
    const r = await this.imd.bind(this.record.tokenId, agentId, txHash);
    if (!r.ok) throw new Error(`IMD /agents/bind ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    const bound = !(r.json && r.json.pending);
    this.save({ phase: bound ? 'bound' : 'completed', agentId, bound, bindResponse: { status: r.status, response: r.json } });
    this.log(bound ? `IMD bound agent ${agentId} to seat ${this.record.tokenId}` : 'IMD accepted the bind as pending; run resume later');
    if (!bound) throw new Error('bind pending on IMD; run resume later');
    return agentId;
  }

  /// Phase 5: IMD's seat standing shows the enrolment for this device.
  async waitForStanding({ timeoutMs = 5 * 60_000 } = {}) {
    const t0 = this.now();
    const device = this.record.artifact.message.deviceKey.slice(2);
    for (;;) {
      this.check();
      const st = await this.imd.seatStanding(this.record.tokenId);
      const key = st.ok && st.json && st.json.enrollment ? lower(String(st.json.enrollment.deviceKey || '').replace(/^0x/, '')) : '';
      if (key === device) { this.save({ phase: 'done', standing: st.json }); this.log(`IMD lists seat ${this.record.tokenId} with device ${device.slice(0, 10)}…`); return st.json; }
      if (this.now() - t0 > timeoutMs) throw new Error('IMD does not show the enrolment yet; run resume later');
      await sleep(this.pollMs);
    }
  }

  /// Resume from wherever the record says; the phases are idempotent, and an unanswered completion is reconciled
  /// with IMD before the approval is waited for again.
  async resume() {
    if (!this.record || !this.record.artifact) throw new Error('nothing to resume: run pair first');
    const phase = this.record.phase;
    if (phase === 'expired') throw new Error('the last attempt expired; run pair again');
    if (phase === 'done') return this.record;
    await this.checkVault(); // the same proof as at the start: factory provenance, pinned terms, our operator, the seat held
    if (phase === 'completing' && (await this.reconcileCompletion())) { /* completed earlier */ }
    if (this.record.phase === 'offered' || this.record.phase === 'completing') { await this.waitForApproval(); await this.complete(); }
    if (this.record.phase === 'completed') await this.bindAgent();
    if (this.record.phase === 'bound') await this.waitForStanding();
    return this.record;
  }
}
