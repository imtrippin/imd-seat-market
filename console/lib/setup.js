// Local console client. The relay coordinates people; it never supplies calldata
// or an authority to sign. Pairing offers still pass the existing local checks.
import { roomMessage } from './room-message.js';
export class Setup {
  constructor(session) { this.session = session; this.auth = null; this.room = null; this.error = null; this.fetchedAt = 0; this.armedUntil = 0; this.armAttempt = null; this.ticking = false; this.armEpoch = 0; }
  async request(action, body = {}, token = this.auth?.token) {
    const r = await fetch(`${this.session.config.setupUrl}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: 'error' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Setup service unavailable');
    return j;
  }
  clear() {
    if (this.auth) this.request('heartbeat', { active: false }).catch(() => {});
    this.auth = null; this.room = null; this.error = null; this.autoError = null; this.armedUntil = 0; this.armAttempt = null; this.pendingAuth = null; this.armEpoch++;
  }
  view() { return { account: this.auth?.account || null, role: this.auth?.role || null, room: this.room, error: this.error || this.autoError || null, fetchedAt: this.fetchedAt, service: this.session.config.setupUrl, armedUntil: this.armedUntil }; }
  async act(action, body = {}) {
    const s = this.session;
    if (!s.snapshot) throw new Error('Select a vault first');
    if (action === 'leave') { this.clear(); return this.view(); }
    if (action === 'arm') {
      if (this.auth?.role !== 'host' || !s.operator || s.operator.address.toLowerCase() !== s.snapshot.operator.toLowerCase()) throw new Error('Host sign-in and the agreed local operator key are required for automatic setup');
      await this.act('heartbeat', { active: true });
      await this.act('ready', { ready: true, version: this.room.schedule.version });
      this.armedUntil = Date.now() + 30 * 60_000; this.armAttempt = null; this.armEpoch++; this.autoError = null;
      return this.view();
    }
    if (action === 'disarm') { this.armedUntil = 0; this.armAttempt = null; this.armEpoch++; return this.act('ready', { ready: false, version: this.room.schedule.version }); }
    if (action === 'challenge') {
      const c = await this.request('challenge', { vault: s.snapshot.address, account: body.account }, null);
      const account = String(body.account || '').toLowerCase();
      const role = account === s.snapshot.owner.toLowerCase() ? 'owner' : [s.snapshot.provider.toLowerCase(), s.snapshot.operator.toLowerCase()].includes(account) ? 'host' : null;
      if (!role || c.role !== role || !/^[a-f0-9]{48}$/.test(c.nonce) || !Number.isSafeInteger(c.until) || c.until <= Date.now() || c.until > Date.now() + 150_000) throw new Error('Setup service returned an invalid sign-in challenge');
      const expected = roomMessage({ service: s.config.setupUrl, chainId: s.config.chainId, vault: s.snapshot.address, account, role, nonce: c.nonce, until: c.until });
      if (c.message !== expected) throw new Error('Setup sign-in message does not match this agreement');
      this.pendingAuth = { nonce: c.nonce, account, role, vault: s.snapshot.address.toLowerCase() };
      return c;
    }
    if (action === 'join') {
      const expected = this.pendingAuth; this.pendingAuth = null;
      if (!expected || expected.nonce !== body.nonce || expected.vault !== s.snapshot.address.toLowerCase()) throw new Error('Request a fresh room sign-in first');
      const j = await this.request('join', body, null);
      if (j.room.vault.toLowerCase() !== s.snapshot.address.toLowerCase() || String(j.account).toLowerCase() !== expected.account || j.role !== expected.role || !/^[a-f0-9]{48}$/.test(j.token)) throw new Error('Setup room identity does not match');
      this.auth = { token: j.token, account: j.account, role: j.role }; this.room = j.room;
    } else {
      if (!this.auth) throw new Error('Join the setup room first');
      if (body.account && body.account.toLowerCase() !== this.auth.account.toLowerCase()) throw new Error('The wallet changed; join the room again');
      if (action === 'ready' && body.ready === true) {
        await s.refresh();
        if (s.error || !s.snapshot.held || s.snapshot.ended) throw new Error('Refresh the chain and deposit the NFT first');
        if (this.auth.role === 'owner' && await s.client.getBalance({ address: s.snapshot.owner }) === 0n && !await s.client.getCode({ address: s.snapshot.owner })) throw new Error('The owner wallet needs gas before pairing');
        if (this.auth.role === 'host' && !s.operator && this.auth.account.toLowerCase() !== s.snapshot.operator.toLowerCase()) throw new Error('Connect the operator wallet, or configure the agreed operator key locally');
        if (s.operator && this.auth.role === 'host' && s.operator.address.toLowerCase() !== s.snapshot.operator.toLowerCase()) throw new Error('Local operator key does not match this vault');
      }
      if (action === 'heartbeat' && body.active === false && this.armedUntil > Date.now()) return this.view();
      if (action === 'pending') {
        if (!/^0x[0-9a-fA-F]{64}$/.test(body.hash) || this.auth.role !== 'owner') throw new Error('Only the owner can record an approval hash');
        s.notePendingApproval(body.hash);
      }
      this.room = await this.request(action, body);
    }
    this.error = null; this.fetchedAt = Date.now();
    return this.view();
  }
  async refresh() {
    if (!this.auth) return;
    try {
      await this.act('state');
      const a = this.room.attempt;
      if (a?.phase === 'offered' && a.offer && a.offer !== this.session.state.pairing.offer) await this.session.importPairingOffer(a.offer);
    } catch (e) { this.error = e.message; this.room = null; }
  }
  async tick() {
    if (this.ticking || !this.auth || !this.armedUntil) return;
    this.ticking = true;
    const epoch = this.armEpoch;
    const allowed = () => this.armEpoch === epoch && this.armedUntil > Date.now();
    try {
      if (this.armedUntil <= Date.now()) { this.armedUntil = 0; await this.act('heartbeat', { active: false }); return; }
      await this.session.refresh();
      if (!allowed()) return;
      if (this.session.error || this.session.snapshot?.ended || !this.session.snapshot?.held) throw new Error('Automatic setup paused: vault is not ready');
      await this.act('heartbeat', { active: true });
      await this.refresh();
      if (!allowed()) return;
      if (!this.room) throw new Error(this.error || 'Room unavailable');
      if (!this.armAttempt && this.room.bothReady) {
        await this.session.startPairing(undefined, allowed);
        this.armAttempt = this.room.attempt.id;
      } else if (!this.armAttempt && !this.room.parties.host.ready && !this.room.attempt) {
        await this.act('ready', { ready: true, version: this.room.schedule.version });
      }
      if (this.armAttempt) {
        if (this.room.attempt?.id !== this.armAttempt || this.room.attempt.phase === 'expired') throw new Error('This setup attempt expired; enable automatic setup again to retry');
        const a = this.session.state.pairing.artifact;
        if (a && this.session.snapshot.approvedDigest.toLowerCase() === a.digest.toLowerCase()) {
          await this.session.completePairing(null, allowed);
          this.armedUntil = 0; this.armAttempt = null;
        }
      }
    } catch (e) { if (this.armEpoch === epoch) { this.autoError = e.message; this.armedUntil = 0; this.armAttempt = null; } }
    finally { this.ticking = false; }
  }
}
