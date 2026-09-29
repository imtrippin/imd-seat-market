// Coordination only. No transaction signing, wallet keys, IMD writes or custody.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeOffer, validateArtifact, expiryProblems, PAIRING_PREFIX } from './pairing.js';
import { roomMessage } from './room-message.js';

const id = () => randomBytes(24).toString('hex');
const lower = (s) => String(s || '').toLowerCase();
const address = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s));
export const PRESENCE_MS = 45_000;
export const READY_MS = 10 * 60_000;
export const START_BUFFER_MS = 60_000;

export class Rooms {
  constructor({ config, lookup, verify, receipt, now = Date.now, file = null }) {
    Object.assign(this, { config, lookup, verify, receipt, now, file });
    this.rooms = new Map(); this.challenges = new Map(); this.tokens = new Map();
    if (file && existsSync(file)) {
      for (const r of JSON.parse(readFileSync(file, 'utf8'))) {
        // Availability and authentication never survive a service restart.
        if (r.updatedAt > now() - 32 * 86400_000) this.rooms.set(r.vault, { ...r, parties: {} });
      }
    }
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const data = [...this.rooms.values()].map(({ parties, ...r }) => r);
    writeFileSync(this.file + '.tmp', JSON.stringify(data));
    renameSync(this.file + '.tmp', this.file);
  }
  async vault(vault) {
    if (!address(vault)) throw new Error('Invalid vault address');
    const v = await this.lookup(vault);
    for (const k of ['collection', 'rewardToken', 'registrar']) {
      if (lower(v[k]) !== lower(this.config[k])) throw new Error('Vault does not match the configured ' + k);
    }
    if (v.relayOrigin !== this.config.relayOrigin) throw new Error('Vault relay does not match');
    return v;
  }
  async challenge({ vault, account }) {
    for (const [k, c] of this.challenges) if (c.until <= this.now()) this.challenges.delete(k);
    if (this.challenges.size >= 256) throw new Error('Too many pending sign-ins; try shortly');
    const v = await this.vault(vault);
    const role = lower(account) === lower(v.owner) ? 'owner'
      : [lower(v.provider), lower(v.operator)].includes(lower(account)) ? 'host' : null;
    if (!role) throw new Error('Only the NFT owner, host or agreed operator can join');
    const nonce = id(), until = this.now() + 120_000;
    const message = roomMessage({ service: this.config.setupUrl, chainId: this.config.chainId, vault, account, role, nonce, until });
    this.challenges.set(nonce, { vault: lower(vault), account, role, message, until });
    return { nonce, message, until, role };
  }
  async join({ nonce, signature }) {
    const c = this.challenges.get(nonce);
    this.challenges.delete(nonce); // single use, including a refused signature
    if (!c || c.until <= this.now()) throw new Error('Sign-in expired; sign in again');
    if (!await this.verify(c.account, c.message, signature)) throw new Error('Room signature is not valid');
    if (c.until <= this.now()) throw new Error('Sign-in expired during verification; sign in again');
    let r = this.rooms.get(c.vault);
    if (!r) {
      if (this.rooms.size >= 200) throw new Error('Setup service room limit reached');
      r = { vault: c.vault, updatedAt: this.now(), schedule: { version: 0, at: null, accepted: {} }, attempt: null, parties: {} };
      this.rooms.set(c.vault, r);
    }
    for (const [key, t] of this.tokens) if (t.until <= this.now() || (t.vault === c.vault && t.role === c.role)) this.tokens.delete(key);
    const token = id();
    this.tokens.set(token, { ...c, until: this.now() + 3600_000 });
    r.parties[c.role] = { seen: this.now(), readyUntil: 0 };
    this.save();
    return { token, account: c.account, role: c.role, room: this.view(r) };
  }
  auth(token) {
    const t = this.tokens.get(token);
    if (!t || t.until <= this.now()) throw new Error('Setup sign-in expired; join again');
    return { t, r: this.rooms.get(t.vault) };
  }
  presence(p) {
    const online = !!p && this.now() - p.seen < PRESENCE_MS;
    return { online, ready: online && p.readyUntil > this.now(), readyUntil: online ? p.readyUntil : 0 };
  }
  view(r) {
    const parties = Object.fromEntries(['owner', 'host'].map((role) => [role, this.presence(r.parties[role])]));
    const a = r.attempt;
    return { vault: r.vault, schedule: r.schedule, parties, bothReady: parties.owner.ready && parties.host.ready,
      attempt: a ? { ...a, phase: a.expiresAt <= this.now() ? 'expired' : a.phase } : null, now: this.now() };
  }
  async act(token, action, body = {}) {
    const { t, r } = this.auth(token);
    const p = r.parties[t.role];
    if (action === 'state') return this.view(r);
    if (action === 'heartbeat') {
      if (body.active === true) { if (!this.presence(p).online) p.readyUntil = 0; p.seen = this.now(); }
      else { p.seen = 0; p.readyUntil = 0; }
    } else if (action === 'schedule') {
      if (r.attempt && r.attempt.expiresAt > this.now()) throw new Error('Finish this pairing attempt before rescheduling');
      const at = body.at;
      if (at !== null && (!Number.isSafeInteger(at) || at < this.now() + 60_000 || at > this.now() + 30 * 86400_000)) throw new Error('Choose a time between one minute and 30 days from now');
      r.schedule = { version: r.schedule.version + 1, at, accepted: { [t.role]: true } };
      for (const party of Object.values(r.parties)) party.readyUntil = 0;
    } else if (action === 'accept') {
      if (body.version !== r.schedule.version) throw new Error('The appointment changed; review the latest time');
      r.schedule.accepted[t.role] = true;
    } else if (action === 'ready') {
      if (body.version !== r.schedule.version) throw new Error('The appointment changed; review the latest time');
      if (body.ready !== true) p.readyUntil = 0;
      else {
        if (!this.presence(p).online) throw new Error('Reopen the console before marking ready');
        if (r.schedule.at && r.schedule.at > this.now() + READY_MS) throw new Error('Come back within ten minutes of the appointment');
        if (r.schedule.version && !r.schedule.accepted[t.role]) throw new Error('Confirm the appointment first');
        const v = await this.vault(t.vault);
        if (!v.held || v.ended || lower(v.seatOwner) !== lower(t.vault)) throw new Error('Deposit or record the NFT before marking ready');
        p.readyUntil = this.now() + READY_MS;
      }
    } else if (action === 'begin') {
      if (t.role !== 'host') throw new Error('Only the host starts pairing');
      if (!this.view(r).bothReady) throw new Error('Both people must be online and ready');
      if (r.attempt && r.attempt.expiresAt > this.now()) throw new Error('A pairing attempt is already in progress');
      // Never discard a broadcast approval just because the pairing timer expired.
      const previous = r.attempt;
      for (const hash of r.attempt?.pending || []) if (!await this.receipt(hash)) throw new Error('An approval transaction is still unresolved; check the wallet before retrying');
      if (r.attempt !== previous || !this.view(r).bothReady) throw new Error('Readiness or the pairing attempt changed; refresh');
      r.attempt = { id: id(), phase: 'starting', expiresAt: this.now() + START_BUFFER_MS, offer: null, pending: [] };
      for (const party of Object.values(r.parties)) party.readyUntil = 0;
    } else if (action === 'offer') {
      if (t.role !== 'host' || r.attempt?.id !== body.attemptId || r.attempt.phase !== 'starting' || r.attempt.expiresAt <= this.now()) throw new Error('Pairing start reservation expired');
      const a = decodeOffer(PAIRING_PREFIX, body.offer);
      const problems = [...validateArtifact(a), ...expiryProblems(a, this.now())];
      const v = await this.vault(t.vault);
      if (lower(a.vault) !== t.vault || lower(a.message?.wallet) !== t.vault || a.chain !== this.config.chainId || lower(a.collection) !== lower(this.config.collection)
        || lower(a.message?.deviceKey) !== lower(v.deviceKey) || String(a.message?.tokenId) !== String(v.tokenId) || a.message?.relayOrigin !== this.config.relayOrigin) problems.push('Pairing offer does not match this agreement');
      const deadline = Math.min(Number(a.codeExpiresAt), Number(a.message?.expiresAt) * 1000);
      if (!Number.isFinite(deadline) || deadline < this.now() + START_BUFFER_MS || deadline > this.now() + 3600_000) problems.push('Not enough verified time left in the pairing offer');
      if (problems.length) throw new Error(problems.join('; '));
      if (r.attempt?.id !== body.attemptId || r.attempt.phase !== 'starting' || r.attempt.expiresAt <= this.now()) throw new Error('Pairing attempt changed while checking the offer');
      Object.assign(r.attempt, { offer: body.offer, phase: 'offered', expiresAt: deadline });
    } else if (action === 'pending') {
      if (t.role !== 'owner' || !r.attempt || r.attempt.id !== body.attemptId || !/^0x[0-9a-fA-F]{64}$/.test(body.hash)) throw new Error('Invalid approval transaction');
      if (!r.attempt.pending.includes(body.hash)) {
        if (r.attempt.pending.length >= 8) throw new Error('Check outstanding wallet transactions before continuing');
        r.attempt.pending.push(body.hash);
      }
    } else throw new Error('Unknown setup action');
    r.updatedAt = this.now();
    if (action !== 'heartbeat') this.save();
    return this.view(r);
  }
}
