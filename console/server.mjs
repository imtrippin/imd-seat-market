#!/usr/bin/env node
// Seat console: a loopback server for one hosting agreement. It reads the chain and IMD's public API, prepares
// calldata, tracks receipts and keeps a log; the browser page only shows state and asks the wallet to sign.
//   node server.mjs [--config config.json] [--port 18820]
// Env: SEAT_CONSOLE_PORT, SEAT_CONSOLE_CONFIG, SEAT_CONSOLE_DATA (data dir), OPERATOR_KEY (host only: 0x private key
// of the vault's operator, used solely to sign the pairing digest; never printed, never sends a transaction).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.js';
import { Session } from './lib/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/setup.js': ['setup.js', 'text/javascript; charset=utf-8'],
};

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 200_000) throw new Error('body too large'); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export function createConsoleServer(session, { log = () => {} } = {}) {
  const server = http.createServer(async (req, res) => {
    // The signing console is loopback-only, including its Host/Origin boundary.
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) { res.writeHead(403).end(); return; }
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        res.end(readFileSync(join(here, 'public', file)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        await session.refresh();
        await session.refreshImd();
        await session.setup.refresh();
        return send(res, 200, session.view());
      }
      if (req.method === 'GET' && url.pathname === '/api/vaults') {
        return send(res, 200, await session.vaults({ owner: url.searchParams.get('owner') || undefined, provider: url.searchParams.get('provider') || undefined }));
      }
      if (req.method === 'GET' && url.pathname === '/api/pairing/typed-data') return send(res, 200, session.pairingTypedData());
      if (req.method !== 'POST') { res.writeHead(404).end(); return; }
      if (!String(req.headers['content-type']).startsWith('application/json')) { res.writeHead(415).end(); return; }
      const body = await readBody(req);
      if (url.pathname.startsWith('/api/setup/')) {
        const action = url.pathname.slice('/api/setup/'.length);
        if (!['challenge', 'join', 'heartbeat', 'ready', 'schedule', 'accept', 'pending', 'leave', 'arm', 'disarm'].includes(action)) throw new Error('Unknown setup action');
        return send(res, 200, await session.setup.act(action, body));
      }
      switch (url.pathname) {
        case '/api/vault': await session.selectVault(body.address); return send(res, 200, session.view());
        case '/api/reset': session.reset(); return send(res, 200, session.view());
        case '/api/hosting-offer/build': return send(res, 200, session.buildHostingOffer(body));
        case '/api/hosting-offer/import': session.importHostingOffer(body.offer); return send(res, 200, session.view());
        case '/api/tx/build': return send(res, 200, session.buildTx(body.action, body.params || {}));
        case '/api/tx/sent': await session.txSent(body.action, body.hash, body.from); return send(res, 200, session.view());
        case '/api/pairing/start': return send(res, 200, await session.startPairing(body.deviceKey));
        case '/api/pairing/import': return send(res, 200, await session.importPairingOffer(body.offer));
        case '/api/pairing/complete': return send(res, 200, await session.completePairing(body.signature || null));
        case '/api/register/intent': return send(res, 200, await session.fetchRegisterIntent());
        case '/api/register/bind': return send(res, 200, await session.bind());
        default: res.writeHead(404).end();
      }
    } catch (e) {
      log(`error ${req.method} ${url.pathname}: ${e.message}`);
      send(res, 400, { error: e.message });
    }
  });
  return server;
}

export async function startConsole({ config, port = 0, dataDir, operatorKey = null, fetchImpl = fetch, log = () => {} }) {
  const session = new Session(config, { dataDir, operatorKey, fetchImpl, log });
  await session.refresh();
  const server = createConsoleServer(session, { log });
  const timer = setInterval(() => session.setup.tick(), 3000);
  timer.unref(); server.on('close', () => clearInterval(timer));
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { session, server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
  const configPath = arg('--config', process.env.SEAT_CONSOLE_CONFIG || join(here, 'config.json'));
  if (!existsSync(configPath)) { console.error(`no config at ${configPath}; copy config.example.json to config.json and fill it in`); process.exit(2); }
  const config = loadConfig(configPath);
  const port = Number(arg('--port', process.env.SEAT_CONSOLE_PORT || 18820));
  const operatorKey = process.env.OPERATOR_KEY && /^0x[0-9a-fA-F]{64}$/.test(process.env.OPERATOR_KEY) ? process.env.OPERATOR_KEY : null;
  const { port: bound, session } = await startConsole({ config, port, dataDir: process.env.SEAT_CONSOLE_DATA || join(here, 'data'), operatorKey, log: (m) => console.log(new Date().toISOString(), m) });
  console.log(`seat console on http://127.0.0.1:${bound}/  chain ${config.chainId}  factory ${config.factory}  IMD ${config.imdApi}${operatorKey ? `  operator key loaded (${session.operator.address})` : '  no operator key (host signs in the wallet)'}`);
}
