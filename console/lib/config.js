// Console configuration: one chain, one factory, the pinned IMD pieces, IMD's API origin and a public RPC.
import { readFileSync } from 'node:fs';

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function validateConfig(c) {
  const problems = [];
  if (!c || typeof c !== 'object') return ['config is not an object'];
  if (!Number.isInteger(c.chainId) || c.chainId <= 0) problems.push('chainId must be a positive integer');
  if (typeof c.rpcUrl !== 'string' || !/^https?:\/\//.test(c.rpcUrl)) problems.push('rpcUrl must be an http(s) URL');
  for (const k of ['factory', 'collection', 'rewardToken', 'registrar']) {
    if (!ADDR.test(String(c[k] ?? ''))) problems.push(`${k} must be a 0x address`);
  }
  if (typeof c.relayOrigin !== 'string' || !/^https:\/\/[^\s/]+$/.test(c.relayOrigin)) problems.push('relayOrigin must be an https origin');
  if (c.imdApi !== undefined && !/^https?:\/\/[^\s/]+$/.test(String(c.imdApi))) problems.push('imdApi must be an origin');
  if (c.explorer !== undefined && !/^https?:\/\/[^\s]+$/.test(String(c.explorer))) problems.push('explorer must be a URL');
  if (c.setupUrl !== undefined) {
    try {
      const u = new URL(c.setupUrl);
      if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new Error();
    } catch { problems.push('setupUrl must be an HTTPS origin, or HTTP on loopback'); }
  }
  return problems;
}

export function normalizeConfig(c) {
  return {
    chainId: c.chainId,
    rpcUrl: c.rpcUrl,
    imdApi: (c.imdApi || 'https://api.imd.fun').replace(/\/$/, ''),
    factory: c.factory,
    collection: c.collection,
    rewardToken: c.rewardToken,
    registrar: c.registrar,
    relayOrigin: c.relayOrigin,
    explorer: c.explorer ? String(c.explorer).replace(/\/$/, '') : null,
    rewardSymbol: c.rewardSymbol || 'IMD',
    rewardDecimals: Number.isInteger(c.rewardDecimals) ? c.rewardDecimals : 18,
    pollMs: Number.isInteger(c.pollMs) ? Math.max(2000, c.pollMs) : 6000,
    imdPollMs: Number.isInteger(c.imdPollMs) ? Math.max(5000, c.imdPollMs) : 20000,
    setupUrl: (c.setupUrl || 'http://127.0.0.1:18821').replace(/\/$/, ''),
  };
}

export function loadConfig(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const problems = validateConfig(raw);
  if (problems.length) throw new Error(`config ${path}: ${problems.join('; ')}`);
  return normalizeConfig(raw);
}
