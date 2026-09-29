// Pairing for a vault-held seat, shared by the host helper and the agreement page (browser-safe: no Node APIs).
// Validates IMD's pairing response, builds the WorkerAuthorization message the owner approves on the vault and the
// operator signs, the exact body /pair/complete expects, and the two strings the host gives the owner: a hosting
// offer (who the host is) and a pairing offer (IMD's challenge for one attempt, plus the registration intent).

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;
const HEX32_PREFIXED = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const CODE = /^[A-Za-z0-9]{4,16}$/;
export const SELECTOR_REGISTER = '0xb68ca002';
export const SELECTOR_REGISTER_META = '0x1fd8046a';

/// Unix seconds or milliseconds (number or numeric string; 12 digits or more are milliseconds) or an ISO date → ms.
export function parseExpiry(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value >= 1e11 ? value : value * 1000;
  if (typeof value === 'string') {
    if (/^\d{9,11}$/.test(value)) return Number(value) * 1000;
    if (/^\d{12,14}$/.test(value)) return Number(value);
    const t = Date.parse(value);
    if (Number.isFinite(t) && /\d{4}-\d{2}-\d{2}/.test(value)) return t;
  }
  return NaN;
}

export function validatePairing(p, expect, nowMs = Date.now()) {
  const problems = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['pairing response is not an object'];
  if (!CODE.test(String(p.code ?? ''))) problems.push('code is missing or malformed');
  if (!HEX32.test(String(p.deviceKey ?? ''))) problems.push('deviceKey is not 32 bytes of hex');
  if (!HEX32.test(String(p.nonce ?? ''))) problems.push('nonce is not 32 bytes of hex');
  if (typeof p.relayOrigin !== 'string' || p.relayOrigin !== expect.relay) problems.push(`relayOrigin ${JSON.stringify(p.relayOrigin)} is not the agreed ${expect.relay}`);
  if (!Number.isSafeInteger(Number(p.chainId)) || Number(p.chainId) !== expect.chain) problems.push(`chainId ${p.chainId} is not ${expect.chain}`);
  if (String(p.nftContract ?? '').toLowerCase() !== expect.collection.toLowerCase()) problems.push(`nftContract ${p.nftContract} is not the agreed collection ${expect.collection}`);
  if (p.consumed) problems.push('pairing code already consumed');
  if (p.enrolled) problems.push('token already enrolled; unlink or withdraw first');
  if (p.expiresAt !== undefined) {
    const t = parseExpiry(p.expiresAt);
    if (!Number.isFinite(t)) problems.push(`expiresAt ${JSON.stringify(p.expiresAt)} is not a timestamp`);
    else if (t <= nowMs) problems.push('pairing code has expired');
  }
  if (p.tokenId !== undefined && String(p.tokenId) !== String(expect.token)) problems.push(`response tokenId ${p.tokenId} is not the vault's token ${expect.token}`);
  return problems;
}

const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

export function buildMessage(p, expect, expiresAtSeconds) {
  return {
    deviceKey: '0x' + strip(p.deviceKey),
    wallet: expect.vault.toLowerCase(),
    tokenId: String(expect.token),
    nonce: '0x' + strip(p.nonce),
    expiresAt: Number(expiresAtSeconds),
    relayOrigin: p.relayOrigin,
  };
}

export const WORKER_AUTHORIZATION_TYPES = {
  WorkerAuthorization: [
    { name: 'deviceKey', type: 'bytes32' },
    { name: 'wallet', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'relayOrigin', type: 'string' },
  ],
};

/// viem-style typed data (bigint fields).
export const typedData = (artifact) => ({
  domain: { name: 'IdentityMD Worker', version: '2', chainId: artifact.chain, verifyingContract: artifact.collection },
  types: WORKER_AUTHORIZATION_TYPES,
  primaryType: 'WorkerAuthorization',
  message: { ...artifact.message, tokenId: BigInt(artifact.message.tokenId), expiresAt: BigInt(artifact.message.expiresAt) },
});

/// The body /pair/complete expects: decimal token id (a string), numeric expiry, unprefixed device key and nonce,
/// lowercase wallet. Every transport field is named on purpose so nothing else rides along.
export const completionBody = (artifact, signature) => ({
  code: artifact.code,
  signature,
  message: {
    deviceKey: artifact.message.deviceKey.slice(2),
    wallet: artifact.message.wallet,
    tokenId: String(artifact.message.tokenId),
    nonce: artifact.message.nonce.slice(2),
    expiresAt: artifact.message.expiresAt,
    relayOrigin: artifact.message.relayOrigin,
  },
});

function isUint256String(v) {
  return typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < (1n << 256n);
}

/// IMD's register-intent, checked against the pinned registrar and this seat: `register(uint8 standard = 0,
/// address collection, uint256 tokenId, string uri)` (or the metadata overload) to the registrar on this chain.
export function validateIntent(intent, expect) {
  const problems = [];
  if (!intent || typeof intent !== 'object') return ['intent missing'];
  if (String(intent.to || '').toLowerCase() !== expect.registrar.toLowerCase()) problems.push(`intent targets ${intent.to}, not the pinned registrar ${expect.registrar}`);
  if (Number(intent.chainId) !== expect.chain) problems.push(`intent chainId ${intent.chainId} is not ${expect.chain}`);
  const data = String(intent.data || '');
  if (!/^0x[0-9a-fA-F]+$/.test(data) || data.length < 2 + 8 + 192) return [...problems, 'intent calldata is too short'];
  const selector = data.slice(0, 10).toLowerCase();
  if (selector !== SELECTOR_REGISTER && selector !== SELECTOR_REGISTER_META) problems.push(`intent selector ${selector} is not a register function`);
  const words = data.slice(10);
  const standard = BigInt('0x' + words.slice(0, 64));
  const tokenContract = '0x' + words.slice(64 + 24, 128);
  const tokenId = BigInt('0x' + words.slice(128, 192));
  if (standard !== 0n) problems.push('intent standard is not ERC-721 (0)');
  if (tokenContract.toLowerCase() !== expect.collection.toLowerCase()) problems.push(`intent names collection ${tokenContract}, not ${expect.collection}`);
  if (tokenId.toString() !== String(expect.token)) problems.push(`intent names token ${tokenId}, not this vault's seat ${expect.token}`);
  return problems;
}

export function validateArtifact(a) {
  const problems = [];
  if (!a || typeof a !== 'object') return ['artifact missing'];
  if (!CODE.test(String(a.code ?? ''))) problems.push('code missing');
  if (!ADDR.test(String(a.vault ?? ''))) problems.push('vault is not an address');
  if (!ADDR.test(String(a.collection ?? ''))) problems.push('collection is not an address');
  if (!Number.isSafeInteger(a.chain) || a.chain <= 0) problems.push('chain is not a chain id');
  if (!HEX32_PREFIXED.test(String(a.digest ?? ''))) problems.push('digest is not 0x + 64 lowercase hex');
  const m = a.message;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return [...problems, 'message missing'];
  if (!HEX32_PREFIXED.test(String(m.deviceKey ?? ''))) problems.push('message.deviceKey is not 0x + 64 lowercase hex');
  if (!HEX32_PREFIXED.test(String(m.nonce ?? ''))) problems.push('message.nonce is not 0x + 64 lowercase hex');
  if (typeof m.wallet !== 'string' || m.wallet !== String(a.vault ?? '').toLowerCase()) problems.push('message.wallet is not the vault');
  if (!isUint256String(m.tokenId)) problems.push('message.tokenId is not a decimal string that fits a uint256');
  if (!Number.isSafeInteger(m.expiresAt) || m.expiresAt <= 0) problems.push('message.expiresAt is not a positive integer');
  if (typeof m.relayOrigin !== 'string' || !/^https:\/\/[^\s/]+$/.test(m.relayOrigin)) problems.push('message.relayOrigin is not an https origin');
  if (a.agentId !== undefined && a.agentId !== null && !isUint256String(String(a.agentId))) problems.push('agentId is not a decimal string');
  if (a.intent !== undefined && a.intent !== null) problems.push(...validateIntent(a.intent, { registrar: a.intent?.to || '', chain: a.chain, collection: a.collection, token: m.tokenId }).filter((p) => !p.startsWith('intent targets')));
  return problems;
}

/// The two clocks: the signature's own expiry (whole seconds, on chain) and IMD's pairing-code expiry (ms).
export function expiryProblems(a, nowMs = Date.now()) {
  const problems = [];
  if (a.message.expiresAt <= Math.floor(nowMs / 1000)) problems.push('the approved signature expiry has passed: start a new pairing and approve the new digest');
  if (a.codeExpiresAt !== undefined && a.codeExpiresAt !== null && Number(a.codeExpiresAt) <= nowMs) problems.push("IMD's pairing code has expired: start a new pairing");
  return problems;
}

// ---------------------------------------------------------------- handoff strings (host → owner)

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export const HOSTING_PREFIX = 'seathost1:';
export const PAIRING_PREFIX = 'seatpair1:';

export function encodeOffer(prefix, obj) {
  return prefix + toBase64Url(JSON.stringify(obj));
}

export function decodeOffer(prefix, str) {
  const s = String(str || '').trim();
  if (!s.startsWith(prefix)) throw new Error(`not a ${prefix.slice(0, -1)} string`);
  let obj;
  try { obj = JSON.parse(fromBase64Url(s.slice(prefix.length))); } catch { throw new Error('offer string is not valid'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('offer string is not an object');
  return obj;
}

/// What the owner needs from the host to create the vault.
export function validateHostingOffer(o, expect) {
  const problems = [];
  if (!ADDR.test(String(o.provider ?? ''))) problems.push('provider is not an address');
  if (!ADDR.test(String(o.operator ?? ''))) problems.push('operator is not an address');
  if (!HEX32.test(String(o.deviceKey ?? ''))) problems.push('deviceKey is not 32 bytes of hex');
  if (!Number.isInteger(o.providerBps) || o.providerBps < 0 || o.providerBps > 10_000) problems.push('providerBps must be 0..10000');
  if (String(o.provider ?? '').toLowerCase() === String(o.operator ?? '').toLowerCase()) problems.push('operator must differ from provider');
  if (expect) {
    if (Number(o.chainId) !== expect.chain) problems.push(`chainId ${o.chainId} is not ${expect.chain}`);
    if (typeof o.relayOrigin !== 'string' || o.relayOrigin !== expect.relay) problems.push(`relayOrigin is not the agreed ${expect.relay}`);
    if (expect.collection && String(o.collection || '').toLowerCase() !== expect.collection.toLowerCase()) problems.push('collection is not the agreed one');
  }
  return problems;
}

/// The owner's checks on a pasted pairing string, against the vault it was pasted into.
export function checkPairingOfferAgainstVault(artifact, vault, config, nowMs = Date.now()) {
  const problems = validateArtifact(artifact);
  if (artifact.vault && artifact.vault.toLowerCase() !== vault.address.toLowerCase()) problems.push('the offer is for another vault');
  if (artifact.message && artifact.message.deviceKey !== String(vault.deviceKey).toLowerCase()) problems.push("the offer's device key is not the vault's");
  if (artifact.message && String(artifact.message.tokenId) !== String(vault.tokenId)) problems.push("the offer's token is not the vault's seat");
  if (artifact.message && artifact.message.relayOrigin !== config.relayOrigin) problems.push("the offer's relay is not the agreed one");
  if (artifact.chain !== config.chainId) problems.push('the offer is for another chain');
  if (String(artifact.collection || '').toLowerCase() !== config.collection.toLowerCase()) problems.push('the offer names another collection');
  if (artifact.message && artifact.message.expiresAt > Math.floor(nowMs / 1000) + 3600) problems.push("the offer's expiry is beyond the vault's one-hour window");
  if (artifact.intent) problems.push(...validateIntent(artifact.intent, { registrar: config.registrar, chain: config.chainId, collection: config.collection, token: vault.tokenId }));
  if (artifact.message) problems.push(...expiryProblems(artifact, nowMs));
  return problems;
}
