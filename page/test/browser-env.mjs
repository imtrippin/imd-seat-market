// The environment for the browser tests: Playwright (a dependency, or the machine's Chrome), a loopback server for
// the committed bundle, a simulated chain behind a simulated wallet, and the pasted strings. Nothing leaves the
// loopback (every other request is aborted), no key exists, and every "transaction" is a recorded request.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionResult, decodeFunctionData, keccak256, toHex, stringToHex } from 'viem';
import { SeatVaultAbi, FactoryAbi, erc721Abi, erc20Abi, registrarAbi } from '../../host/lib/chain.js';
import { encodeOffer, PAIRING_PREFIX } from '../../host/lib/pairing.js';

const here = dirname(fileURLToPath(import.meta.url));
export const dist = join(here, '..', 'dist');
export const config = JSON.parse(readFileSync(join(here, '..', 'config.json'), 'utf8'));

async function loadPlaywright() {
  try { return (await import('playwright')).chromium; } catch { /* not a dependency here */ }
  try {
    const r = createRequire(join(process.env.USERPROFILE || process.env.HOME || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json'));
    return r('playwright').chromium;
  } catch { return null; }
}
export const chromium = existsSync(join(dist, 'app.js')) ? await loadPlaywright() : null;
export const skip = !chromium ? 'Playwright (or page/dist) is not available' : false;

/// The bundled Chromium when it is installed, else the machine's own Chrome (a Playwright build without its browsers).
export async function launch() {
  try { return await chromium.launch({ headless: true }); }
  catch (e) { try { return await chromium.launch({ headless: true, channel: 'chrome' }); } catch { throw e; } }
}

export const A = (n) => '0x' + n.repeat(40);
export const H = (n) => '0x' + n.repeat(64);
export const OWNER = A('1'), HOST = A('2'), OPERATOR = A('3'), VAULT = A('a'), FOREIGN = A('f');
export const DEVICE = H('a');
const ZERO32 = H('0');
const TYPES = { 'text/html': '.html', 'text/css': '.css', 'text/javascript': '.js' };

export function serveDist() {
  const server = http.createServer((req, res) => {
    const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const file = join(dist, p);
    if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    const type = Object.entries(TYPES).find(([, ext]) => ext === extname(file))?.[0] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

/// A simulated chain: one factory with one vault, a foreign contract that answers like a vault, the collection, the
/// reward token and the registrar. Transactions are recorded, mined on demand. `calls` keeps every request.
export function simulatedChain(over = {}) {
  const chain = {
    chainId: '0x1', block: 100, sent: [], receipts: {}, calls: [], seatOwner: OWNER, held: false, ended: false,
    approvedDigest: ZERO32, approvedUntil: 0, digest: H('d'), agentBound: null, ...over,
  };
  const vaultFields = (addr) => ({
    owner: OWNER, provider: HOST, operator: OPERATOR, collection: config.collection, tokenId: 7n, rewardToken: config.rewardToken,
    providerBps: 3000, registrar: config.registrar, relayOrigin: config.relayOrigin, deviceKey: DEVICE, held: chain.held, ended: chain.ended,
    endedAt: 0n, approvedDigest: chain.approvedDigest, approvedUntil: BigInt(chain.approvedUntil), approvedChain: 1n, accounted: 0n, pending: 0n, shortfall: 0n,
    address: addr,
  });
  const answer = (abi, name, value) => encodeFunctionResult({ abi, functionName: name, result: value });
  function call({ to, data }) {
    const t = String(to).toLowerCase();
    if (t === config.factory.toLowerCase()) {
      const d = decodeFunctionData({ abi: FactoryAbi, data });
      if (d.functionName === 'count') return answer(FactoryAbi, 'count', 1n);
      if (d.functionName === 'vaults') return answer(FactoryAbi, 'vaults', VAULT);
      if (['collection', 'rewardToken', 'registrar', 'relayOrigin'].includes(d.functionName)) return answer(FactoryAbi, d.functionName, vaultFields(VAULT)[d.functionName]);
    }
    if (t === VAULT.toLowerCase() || t === FOREIGN.toLowerCase()) {
      const d = decodeFunctionData({ abi: SeatVaultAbi, data });
      const f = vaultFields(t === VAULT.toLowerCase() ? VAULT : FOREIGN);
      if (d.functionName === 'claimable') return answer(SeatVaultAbi, 'claimable', 0n);
      if (d.functionName === 'workerAuthorizationDigest') return answer(SeatVaultAbi, 'workerAuthorizationDigest', chain.digest);
      if (d.functionName in f) return answer(SeatVaultAbi, d.functionName, f[d.functionName]);
    }
    if (t === config.collection.toLowerCase()) {
      const d = decodeFunctionData({ abi: erc721Abi, data });
      if (d.functionName === 'ownerOf') return answer(erc721Abi, 'ownerOf', chain.seatOwner);
    }
    if (t === config.rewardToken.toLowerCase()) return answer(erc20Abi, 'balanceOf', 0n);
    if (t === config.registrar.toLowerCase()) {
      const d = decodeFunctionData({ abi: registrarAbi, data });
      if (d.functionName === 'isController') return answer(registrarAbi, 'isController', chain.agentBound === 'vault');
      if (d.functionName === 'bindingOf') return answer(registrarAbi, 'bindingOf', [0, config.collection, 7n]);
    }
    throw new Error(`unexpected call to ${to}: ${String(data).slice(0, 10)}`);
  }
  async function rpc(q) {
    const m = q.method;
    if (m === 'eth_requestAccounts' || m === 'eth_accounts') return [OWNER];
    if (m === 'eth_chainId') return chain.chainId;
    if (m === 'eth_blockNumber') return toHex(chain.block);
    if (m === 'eth_call') return call(q.params[0]);
    if (m === 'eth_getLogs') return [];
    if (m === 'eth_getBlockByNumber') return { number: toHex(chain.block), hash: H('b'), timestamp: toHex(Math.floor(Date.now() / 1000)), transactions: [] };
    if (m === 'eth_sendTransaction') {
      const tx = q.params[0];
      const hash = keccak256(stringToHex(`tx-${chain.sent.length}-${tx.data}`));
      chain.sent.push({ ...tx, hash, chainId: chain.chainId });
      return hash;
    }
    if (m === 'eth_getTransactionByHash') { const tx = chain.sent.find((x) => x.hash === q.params[0]); return tx ? { hash: tx.hash, from: tx.from, to: tx.to, input: tx.data, blockNumber: chain.receipts[tx.hash] ? toHex(chain.block) : null, nonce: '0x1', value: '0x0' } : null; }
    if (m === 'eth_getTransactionReceipt') return chain.receipts[q.params[0]] || null;
    if (m === 'wallet_switchEthereumChain') return null;
    throw new Error(`unexpected rpc ${m}`);
  }
  chain.rpc = async (q) => {
    try { const r = await rpc(q); chain.calls.push({ method: q.method, ok: true }); return r; }
    catch (e) { chain.calls.push({ method: q.method, error: e.message }); throw e; }
  };
  /// mine a sent transaction: an approval records the digest on the simulated vault
  chain.mine = (hash, logs = []) => {
    const tx = chain.sent.find((x) => x.hash === hash);
    if (String(tx.data).startsWith('0x') && String(tx.to).toLowerCase() === VAULT.toLowerCase()) {
      const d = decodeFunctionData({ abi: SeatVaultAbi, data: tx.data });
      if (d.functionName === 'approvePairing') { chain.approvedDigest = chain.digest; chain.approvedUntil = Number(d.args[1]); }
    }
    chain.block += 1;
    chain.receipts[hash] = { transactionHash: hash, blockNumber: toHex(chain.block), blockHash: H('b'), status: '0x1', logs, from: tx.from, to: tx.to, transactionIndex: '0x0', cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', type: '0x2', logsBloom: '0x' + '0'.repeat(512), contractAddress: null };
  };
  return chain;
}

export function pairingString(chain, { codeSeconds = 240 } = {}) {
  const expiresAt = Math.floor(Date.now() / 1000) + codeSeconds;
  const artifact = {
    code: 'C0DE1', vault: VAULT, collection: config.collection, chain: 1, codeExpiresAt: Date.now() + codeSeconds * 1000, digest: chain.digest, agentId: null,
    message: { deviceKey: DEVICE, wallet: VAULT.toLowerCase(), tokenId: '7', nonce: H('e'), expiresAt, relayOrigin: config.relayOrigin },
    intent: { to: config.registrar, chainId: 1, data: '0xb68ca002' + '0'.repeat(64) + config.collection.slice(2).toLowerCase().padStart(64, '0') + (7).toString(16).padStart(64, '0') + '0'.repeat(64), agentURI: null },
  };
  return { text: encodeOffer(PAIRING_PREFIX, artifact), artifact };
}

export const baseRecord = (vault) => ({ seq: 1, vault, artifactText: null, approved: {}, intents: {}, registered: {}, pendingApprovals: {}, log: [] });

/// A browser context whose window.ethereum forwards to the simulated chain; every non-loopback request is aborted.
export async function openContext(browser, base, chain, { swarm = { seats: {} }, record = null, denyStorage = false } = {}) {
  const context = await browser.newContext();
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/swarm') return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(swarm) });
    if (u.origin === base) return route.continue();
    return route.abort();
  });
  await context.exposeBinding('__rpc', (_, q) => chain.rpc(q));
  await context.addInitScript(({ record, denyStorage }) => {
    const listeners = {};
    window.__emit = (event, value) => { for (const f of listeners[event] || []) f(value); };
    window.ethereum = { request: (q) => window.__rpc(q), on: (event, f) => { (listeners[event] ||= []).push(f); } };
    try {
      if (record && !localStorage.getItem('seat-page:1')) localStorage.setItem('seat-page:1', JSON.stringify(record));
      if (denyStorage) { const proto = Object.getPrototypeOf(localStorage); const orig = proto.setItem; proto.setItem = function (k, v) { if (String(k).startsWith('seat-page')) throw new Error('denied'); return orig.call(this, k, v); }; }
    } catch (e) { window.__initError = String(e); }
  }, { record, denyStorage });
  const page = async () => {
    const p = await context.newPage();
    const errors = [];
    const console_ = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => console_.push(`${m.type()}: ${m.text()}`));
    await p.goto(base + '/');
    p.__errors = errors;
    p.__console = console_;
    return p;
  };
  return { context, page };
}
