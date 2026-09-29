// A separate, keyless setup service shared by two local consoles. Private by
// default; remote operation requires a deliberately configured HTTPS endpoint.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Rooms } from './lib/rooms.js';
import { loadConfig } from './lib/config.js';
import { makeClient, readVault } from './lib/chain.js';

export async function startRooms({ config, port = 0, host = '127.0.0.1', file = null, store = null }) {
  const client = makeClient(config.rpcUrl);
  const rooms = store || new Rooms({ config, file,
    lookup: async (vault) => {
      if (await client.getChainId() !== config.chainId) throw new Error('Setup RPC is on the wrong chain');
      return readVault(client, vault);
    },
    verify: (address, message, signature) => client.verifyMessage({ address, message, signature }),
    receipt: async (hash) => { try { return !!await client.getTransactionReceipt({ hash }); } catch { return false; } },
  });
  const limits = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      // No browser CORS, cookies, GET mutations, or keys on this service.
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) return send(405, { error: 'JSON POST required' });
      const path = new URL(req.url, 'http://rooms').pathname;
      if (path === '/challenge' || path === '/join') {
        const k = req.socket.remoteAddress, minute = Math.floor(Date.now() / 60_000);
        for (const [key, v] of limits) if (v.minute !== minute) limits.delete(key);
        const n = limits.get(k) || { minute, count: 0 }; limits.set(k, n);
        if (++n.count > 30) return send(429, { error: 'Too many sign-in attempts; wait a minute' });
      }
      let text = '';
      for await (const chunk of req) { text += chunk; if (text.length > 24000) throw new Error('Request too large'); }
      const body = JSON.parse(text || '{}');
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const out = path === '/challenge' ? await rooms.challenge(body) : path === '/join' ? await rooms.join(body) : await rooms.act(token, path.slice(1), body);
      send(200, out);
    } catch (e) { send(400, { error: e.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { rooms, server, port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const config = loadConfig(process.env.SEAT_CONSOLE_CONFIG || join(here, 'config.json'));
  const service = await startRooms({ config, host: process.env.SETUP_HOST || '127.0.0.1', port: Number(process.env.SETUP_PORT || 18821), file: join(here, 'data', 'rooms.json') });
  console.log(`Setup room service listening on port ${service.port}. No wallet keys or funds are held here.`);
}
