// Shared configuration shape (browser-safe): one chain, one factory, the pinned IMD pieces and IMD's API origin.
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function validateConfig(c, { needRpc = true } = {}) {
  const problems = [];
  if (!c || typeof c !== 'object') return ['config is not an object'];
  if (!Number.isInteger(c.chainId) || c.chainId <= 0) problems.push('chainId must be a positive integer');
  if (needRpc && (typeof c.rpcUrl !== 'string' || !/^https?:\/\//.test(c.rpcUrl))) problems.push('rpcUrl must be an http(s) URL');
  for (const k of ['factory', 'collection', 'rewardToken', 'registrar']) {
    if (!ADDR.test(String(c[k] ?? ''))) problems.push(`${k} must be a 0x address`);
  }
  if (typeof c.relayOrigin !== 'string' || !/^https:\/\/[^\s/]+$/.test(c.relayOrigin)) problems.push('relayOrigin must be an https origin');
  if (c.imdApi !== undefined && !/^https?:\/\/[^\s/]+$/.test(String(c.imdApi))) problems.push('imdApi must be an origin');
  if (c.explorer !== undefined && !/^https?:\/\/[^\s]+$/.test(String(c.explorer))) problems.push('explorer must be a URL');
  return problems;
}

export function normalizeConfig(c) {
  return {
    chainId: c.chainId,
    rpcUrl: c.rpcUrl || null,
    imdApi: (c.imdApi || 'https://api.imd.fun').replace(/\/$/, ''),
    factory: c.factory,
    collection: c.collection,
    rewardToken: c.rewardToken,
    registrar: c.registrar,
    relayOrigin: c.relayOrigin,
    explorer: c.explorer ? String(c.explorer).replace(/\/$/, '') : null,
    rewardSymbol: c.rewardSymbol || 'IMD',
    rewardDecimals: Number.isInteger(c.rewardDecimals) ? c.rewardDecimals : 18,
  };
}

export function parseConfig(raw, opts) {
  const problems = validateConfig(raw, opts);
  if (problems.length) throw new Error(`config: ${problems.join('; ')}`);
  return normalizeConfig(raw);
}
