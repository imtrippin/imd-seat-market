// IMD's public API, called from the host helper (a program, so no cross-origin rule applies). Every call has a
// timeout and nothing is retried in a loop; the caller decides how often to poll (be gentle with api.imd.fun).
export class ImdApi {
  constructor(base, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
    this.base = base.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async call(method, route, body) {
    const res = await this.fetch(this.base + route, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
    return { status: res.status, ok: res.ok, json };
  }

  async startPairing(deviceKey) {
    return this.call('POST', '/pair/start', { deviceKey: String(deviceKey).replace(/^0x/, '').toLowerCase() });
  }

  async pairingStatus(code) {
    return this.call('GET', `/pair/${encodeURIComponent(code)}`);
  }

  async completePairing(body) {
    return this.call('POST', '/pair/complete', body);
  }

  async registerIntent(tokenId) {
    return this.call('GET', `/agents/register-intent?tokenId=${encodeURIComponent(String(tokenId))}`);
  }

  async bind(tokenId, agentId, txHash) {
    const body = { tokenId: String(tokenId) };
    if (agentId !== undefined && agentId !== null) body.agentId = String(agentId);
    if (txHash) body.txHash = txHash;
    return this.call('POST', '/agents/bind', body);
  }

  /// null json when the seat was never paired (404 unknown_seat).
  async seatStanding(tokenId) {
    const r = await this.call('GET', `/seats/${encodeURIComponent(String(tokenId))}/standing`);
    if (r.status === 404) return { status: 404, ok: false, json: null };
    return r;
  }

  /// The one route browsers may read from anywhere: every enrolled seat with its agent id and work counts.
  async swarmSeat(tokenId) {
    const r = await this.call('GET', '/swarm');
    if (!r.ok || !r.json || !r.json.seats) return null;
    return r.json.seats[String(tokenId)] || null;
  }
}
