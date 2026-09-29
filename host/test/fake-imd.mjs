// A stand-in for the IMD routes the helper and the page use, faithful to the documented shapes (docs of 2026-09-28)
// and to the one behaviour that matters for a vault: /pair/complete verifies the WorkerAuthorization signature
// through the holder's ERC-1271 `isValidSignature`. `/swarm` answers with open CORS like the real one. In-memory.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { hashTypedData, encodeFunctionData, parseAbi } from 'viem';
import { SeatVaultAbi, ERC1271_MAGIC } from '../lib/chain.js';
import { WORKER_AUTHORIZATION_TYPES } from '../lib/pairing.js';

const registrarAbi = parseAbi(['function bindings(uint256) view returns (address tokenContract, uint256 tokenId)']);

export async function startFakeImd({ client, chainId, collection, registrar, relayOrigin }) {
  const state = { pairings: new Map(), seats: new Map(), calls: [] };
  const json = (res, status, body, cors = false) => { res.writeHead(status, { 'content-type': 'application/json', ...(cors ? { 'access-control-allow-origin': '*' } : {}) }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    state.calls.push({ method: req.method, path: url.pathname, body });
    try {
      if (req.method === 'POST' && url.pathname === '/pair/start') {
        if (!/^[0-9a-f]{64}$/.test(body.deviceKey || '')) return json(res, 400, { error: 'bad deviceKey' });
        const code = randomBytes(4).toString('hex').toUpperCase();
        const p = { code, deviceKey: body.deviceKey, nonce: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), relayOrigin, chainId, nftContract: collection, consumed: false, enrolled: false, wallet: null, tokenId: null, agentId: null };
        state.pairings.set(code, p);
        return json(res, 200, { code, nonce: p.nonce, expiresAt: p.expiresAt, relayOrigin, chainId, nftContract: collection });
      }
      const m = url.pathname.match(/^\/pair\/([A-Za-z0-9]{4,16})$/);
      if (req.method === 'GET' && m) {
        const p = state.pairings.get(m[1]);
        if (!p) return json(res, 404, { error: 'unknown_code' });
        return json(res, 200, { consumed: p.consumed, enrolled: p.enrolled, wallet: p.wallet, tokenId: p.tokenId, agentId: p.agentId });
      }
      if (req.method === 'POST' && url.pathname === '/pair/complete') {
        const p = state.pairings.get(body.code);
        if (!p) return json(res, 404, { error: 'unknown_code' });
        if (p.consumed) return json(res, 409, { error: 'consumed' });
        const msg = body.message || {};
        if (msg.deviceKey !== p.deviceKey || msg.nonce !== p.nonce || msg.relayOrigin !== relayOrigin) return json(res, 400, { error: 'message does not match the pairing' });
        if (!/^0x[0-9a-f]{40}$/.test(msg.wallet || '') || !/^\d+$/.test(String(msg.tokenId)) || !Number.isInteger(msg.expiresAt)) return json(res, 400, { error: 'bad message' });
        if (msg.expiresAt <= Math.floor(Date.now() / 1000)) return json(res, 400, { error: 'expired' });
        const digest = hashTypedData({ domain: { name: 'IdentityMD Worker', version: '2', chainId, verifyingContract: collection }, types: WORKER_AUTHORIZATION_TYPES, primaryType: 'WorkerAuthorization', message: { deviceKey: '0x' + msg.deviceKey, wallet: msg.wallet, tokenId: BigInt(msg.tokenId), nonce: '0x' + msg.nonce, expiresAt: BigInt(msg.expiresAt), relayOrigin: msg.relayOrigin } });
        let answer;
        try { answer = await client.readContract({ address: msg.wallet, abi: SeatVaultAbi, functionName: 'isValidSignature', args: [digest, body.signature] }); } catch { return json(res, 503, { error: 'ownership unreadable' }); }
        if (String(answer).toLowerCase() !== ERC1271_MAGIC) return json(res, 403, { error: 'signature refused by the holder' });
        Object.assign(p, { consumed: true, enrolled: true, wallet: msg.wallet, tokenId: String(msg.tokenId) });
        const seat = state.seats.get(String(msg.tokenId)) || {};
        state.seats.set(String(msg.tokenId), { ...seat, enrollment: { status: 'active', deviceKey: p.deviceKey, wallet: msg.wallet }, presence: { connected: false, acceptingWork: false, runtimes: [] } });
        return json(res, 200, { deviceKey: p.deviceKey, wallet: msg.wallet, tokenId: String(msg.tokenId), agentId: seat.agentId || null });
      }
      if (req.method === 'GET' && url.pathname === '/agents/register-intent') {
        const tokenId = url.searchParams.get('tokenId');
        if (!/^\d+$/.test(tokenId || '')) return json(res, 400, { error: 'tokenId required' });
        const agentURI = `https://api.imd.fun/agents/by-token/${tokenId}.json`;
        const data = encodeFunctionData({ abi: parseAbi(['function register(uint8 standard, address tokenContract, uint256 tokenId, string agentURI)']), functionName: 'register', args: [0, collection, BigInt(tokenId), agentURI] });
        return json(res, 200, { to: registrar, data, chainId, agentURI });
      }
      if (req.method === 'POST' && url.pathname === '/agents/bind') {
        if (!/^\d+$/.test(String(body.tokenId || ''))) return json(res, 400, { error: 'tokenId required' });
        if (!body.agentId) return json(res, 200, { pending: true });
        const [tokenContract, tokenId] = await client.readContract({ address: registrar, abi: registrarAbi, functionName: 'bindings', args: [BigInt(body.agentId)] });
        if (tokenContract.toLowerCase() !== collection.toLowerCase() || tokenId.toString() !== String(body.tokenId)) return json(res, 409, { error: 'agent is not bound to that seat on chain' });
        const seat = state.seats.get(String(body.tokenId)) || {};
        state.seats.set(String(body.tokenId), { ...seat, agentId: String(body.agentId) });
        return json(res, 200, { ok: true, tokenId: String(body.tokenId), agentId: String(body.agentId) });
      }
      const st = url.pathname.match(/^\/seats\/(\d+)\/standing$/);
      if (req.method === 'GET' && st) {
        const seat = state.seats.get(st[1]);
        if (!seat) return json(res, 404, { error: 'unknown_seat' });
        return json(res, 200, { tokenId: st[1], agentId: seat.agentId || null, enrollment: seat.enrollment || null, presence: seat.presence || null, work: { accepted: 0, rejected: 0, failed: 0, pending: 0 } });
      }
      if (req.method === 'GET' && url.pathname === '/swarm') {
        const seats = {};
        for (const [id, seat] of state.seats) if (seat.enrollment) seats[id] = { tokenId: Number(id), agentId: seat.agentId || null, attempts: 0, accepted: 0, rejected: 0, failed: 0, pending: 0, last: null, working: false, queued: 0 };
        return json(res, 200, { at: new Date().toISOString(), chain: chainId, seats }, true);
      }
      return json(res, 404, { error: 'not_found' });
    } catch (e) { return json(res, 500, { error: e.message }); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((resolve) => server.close(resolve)) };
}
