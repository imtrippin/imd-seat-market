// Chain access for the console: reads through a public RPC, transaction calldata for the wallet to sign, receipt
// decoding. Nothing here holds a key; the only signer the console can carry is the host's operator key for the
// pairing signature (see session.js), and that never sends a transaction.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, encodeFunctionData, decodeEventLog, parseAbi, getAddress } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
export const SeatVaultAbi = JSON.parse(readFileSync(join(here, '..', 'abi', 'SeatVault.json'), 'utf8'));
export const FactoryAbi = JSON.parse(readFileSync(join(here, '..', 'abi', 'SeatVaultFactory.json'), 'utf8'));
export const erc721Abi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function approve(address to, uint256 tokenId)',
  'function transferFrom(address from, address to, uint256 tokenId)',
]);
export const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export const ERC1271_MAGIC = '0x1626ba7e';

export function makeClient(rpcUrl) {
  return createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });
}

const s = (v) => (typeof v === 'bigint' ? v.toString() : v);

/// Everything the console shows about one vault, in one round of reads (all values JSON-safe).
export async function readVault(client, vault) {
  const r = (functionName, args = []) => client.readContract({ address: vault, abi: SeatVaultAbi, functionName, args });
  const [owner, provider, operator, collection, tokenId, rewardToken, providerBps, registrar, relayOrigin, deviceKey] =
    await Promise.all(['owner', 'provider', 'operator', 'collection', 'tokenId', 'rewardToken', 'providerBps', 'registrar', 'relayOrigin', 'deviceKey'].map((f) => r(f)));
  const [held, ended, endedAt, approvedDigest, approvedUntil, approvedChain, accounted, pending, shortfall] =
    await Promise.all(['held', 'ended', 'endedAt', 'approvedDigest', 'approvedUntil', 'approvedChain', 'accounted', 'pending', 'shortfall'].map((f) => r(f)));
  const [claimableOwner, claimableProvider] = await Promise.all([r('claimable', [owner]), r('claimable', [provider])]);
  let seatOwner = null;
  try { seatOwner = await client.readContract({ address: collection, abi: erc721Abi, functionName: 'ownerOf', args: [tokenId] }); } catch { seatOwner = null; }
  let seatApproved = null;
  if (seatOwner && seatOwner.toLowerCase() !== vault.toLowerCase()) {
    try { seatApproved = await client.readContract({ address: collection, abi: erc721Abi, functionName: 'getApproved', args: [tokenId] }); } catch { seatApproved = null; }
  }
  let rewardBalance = null;
  try { rewardBalance = await client.readContract({ address: rewardToken, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }); } catch { rewardBalance = null; }
  return {
    address: vault, owner, provider, operator, collection, tokenId: s(tokenId), rewardToken, providerBps: Number(providerBps),
    registrar, relayOrigin, deviceKey, held, ended, endedAt: Number(endedAt), approvedDigest, approvedUntil: Number(approvedUntil),
    approvedChain: s(approvedChain), accounted: s(accounted), pending: s(pending), shortfall: s(shortfall),
    claimableOwner: s(claimableOwner), claimableProvider: s(claimableProvider), seatOwner, seatApproved, rewardBalance: s(rewardBalance),
  };
}

export async function readFactory(client, factory) {
  const r = (functionName, args = []) => client.readContract({ address: factory, abi: FactoryAbi, functionName, args });
  const [collection, rewardToken, registrar, relayOrigin, count] = await Promise.all([r('collection'), r('rewardToken'), r('registrar'), r('relayOrigin'), r('count')]);
  return { collection, rewardToken, registrar, relayOrigin, count: Number(count) };
}

/// The factory's vaults with their parties, newest first (the factory keeps them in an array; agreements are few).
export async function listVaults(client, factory, limit = 50) {
  const count = Number(await client.readContract({ address: factory, abi: FactoryAbi, functionName: 'count' }));
  const rows = [];
  for (let i = count - 1; i >= 0 && rows.length < limit; i--) {
    const address = await client.readContract({ address: factory, abi: FactoryAbi, functionName: 'vaults', args: [BigInt(i)] });
    const r = (functionName) => client.readContract({ address, abi: SeatVaultAbi, functionName });
    const [owner, provider, tokenId, held, ended] = await Promise.all([r('owner'), r('provider'), r('tokenId'), r('held'), r('ended')]);
    rows.push({ index: i, address, owner, provider, tokenId: s(tokenId), held, ended });
  }
  return rows;
}

// ---------------------------------------------------------------- calldata for the wallet

const vaultCall = (functionName, args = []) => encodeFunctionData({ abi: SeatVaultAbi, functionName, args });

export const tx = {
  create: (factory, { provider, operator, tokenId, providerBps, deviceKey }) => ({
    to: factory,
    data: encodeFunctionData({ abi: FactoryAbi, functionName: 'create', args: [getAddress(provider), getAddress(operator), BigInt(tokenId), Number(providerBps), deviceKey] }),
  }),
  approveSeat: (collection, vault, tokenId) => ({ to: collection, data: encodeFunctionData({ abi: erc721Abi, functionName: 'approve', args: [vault, BigInt(tokenId)] }) }),
  deposit: (vault) => ({ to: vault, data: vaultCall('deposit') }),
  syncHeld: (vault) => ({ to: vault, data: vaultCall('syncHeld') }),
  approvePairing: (vault, nonce, expiresAt, relayOrigin) => ({ to: vault, data: vaultCall('approvePairing', [nonce, BigInt(expiresAt), relayOrigin]) }),
  revokePairing: (vault) => ({ to: vault, data: vaultCall('revokePairing') }),
  registerAgent: (vault, data) => ({ to: vault, data: vaultCall('registerAgent', [data]) }),
  settle: (vault) => ({ to: vault, data: vaultCall('settle') }),
  claim: (vault) => ({ to: vault, data: vaultCall('claim') }),
  end: (vault) => ({ to: vault, data: vaultCall('end') }),
  withdraw: (vault, to) => ({ to: vault, data: vaultCall('withdrawNFT', [getAddress(to)]) }),
};

// ---------------------------------------------------------------- receipts and logs

export async function waitReceipt(client, hash, timeout = 180_000) {
  return client.waitForTransactionReceipt({ hash, timeout, pollingInterval: 2_000 });
}

/// Decodes the vault's and the factory's events out of a receipt; unknown logs are skipped.
export function decodeLogs(receipt) {
  const events = [];
  for (const log of receipt.logs || []) {
    for (const abi of [SeatVaultAbi, FactoryAbi]) {
      try {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
        const args = {};
        for (const [k, v] of Object.entries(ev.args || {})) args[k] = s(v);
        events.push({ address: log.address, name: ev.eventName, args });
        break;
      } catch { /* not this ABI */ }
    }
  }
  return events;
}

export async function isValidSignature(client, vault, digest, signature) {
  const answer = await client.readContract({ address: vault, abi: SeatVaultAbi, functionName: 'isValidSignature', args: [digest, signature] });
  return String(answer).toLowerCase() === ERC1271_MAGIC;
}

export async function workerAuthorizationDigest(client, vault, deviceKey, nonce, expiresAt) {
  return client.readContract({ address: vault, abi: SeatVaultAbi, functionName: 'workerAuthorizationDigest', args: [deviceKey, nonce, BigInt(expiresAt)] });
}

export function formatUnits(value, decimals = 18, places = 4) {
  if (value === null || value === undefined) return '?';
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
