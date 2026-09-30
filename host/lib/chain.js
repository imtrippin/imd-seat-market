// Chain access shared by the host helper and the agreement page (browser-safe): reads, calldata for a wallet to
// sign, receipt decoding, factory provenance, agent binding checks. Nothing here holds a key.
import { createPublicClient, http, custom, encodeFunctionData, decodeEventLog, parseAbi, parseAbiItem, getAddress, ContractFunctionRevertedError } from 'viem';
import SeatVaultAbi from '../abi/SeatVault.json' with { type: 'json' };
import FactoryAbi from '../abi/SeatVaultFactory.json' with { type: 'json' };

export { SeatVaultAbi, FactoryAbi };
export const erc721Abi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
]);
export const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)']);
/// IMD's registrar (Adapter8004, verified source): the immutable binding of an agent (a static tuple, decoded as three
/// words), a revert for an unknown agent, and control that follows the bound token's current owner.
export const registrarAbi = parseAbi([
  'function isController(uint256 agentId, address account) view returns (bool)',
  'function bindingOf(uint256 agentId) view returns (uint8 standard, address tokenContract, uint256 tokenId)',
  'error UnknownAgent(uint256 agentId)',
]);
export const AGENT_REGISTERED = parseAbiItem('event AgentRegistered(uint256 indexed agentId, bytes data)');
export const VAULT_CREATED = parseAbiItem('event VaultCreated(address indexed vault, address indexed owner, address indexed provider, uint256 tokenId, uint16 providerBps)');
export const ERC1271_MAGIC = '0x1626ba7e';

export function httpClient(rpcUrl) {
  return createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });
}

/// A client over a browser wallet's provider (window.ethereum): reads go through the wallet's own connection.
export function providerClient(provider) {
  return createPublicClient({ transport: custom(provider) });
}

const s = (v) => (typeof v === 'bigint' ? v.toString() : v);
const lower = (a) => String(a || '').toLowerCase();

/// Everything shown about one vault, in one round of reads (all values JSON-safe).
export async function readVault(client, vault) {
  const r = (functionName, args = []) => client.readContract({ address: vault, abi: SeatVaultAbi, functionName, args });
  const [owner, provider, operator, collection, tokenId, rewardToken, providerBps, registrar, relayOrigin, deviceKey] =
    await Promise.all(['owner', 'provider', 'operator', 'collection', 'tokenId', 'rewardToken', 'providerBps', 'registrar', 'relayOrigin', 'deviceKey'].map((f) => r(f)));
  const [held, ended, endedAt, approvedDigest, approvedUntil, approvedChain, accounted, pending, shortfall] =
    await Promise.all(['held', 'ended', 'endedAt', 'approvedDigest', 'approvedUntil', 'approvedChain', 'accounted', 'pending', 'shortfall'].map((f) => r(f)));
  const [claimableOwner, claimableProvider] = await Promise.all([r('claimable', [owner]), r('claimable', [provider])]);
  let seatOwner = null;
  try { seatOwner = await client.readContract({ address: collection, abi: erc721Abi, functionName: 'ownerOf', args: [tokenId] }); } catch { seatOwner = null; }
  let rewardBalance = null;
  try { rewardBalance = await client.readContract({ address: rewardToken, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }); } catch { rewardBalance = null; }
  return {
    address: vault, owner, provider, operator, collection, tokenId: s(tokenId), rewardToken, providerBps: Number(providerBps),
    registrar, relayOrigin, deviceKey, held, ended, endedAt: Number(endedAt), approvedDigest, approvedUntil: Number(approvedUntil),
    approvedChain: s(approvedChain), accounted: s(accounted), pending: s(pending), shortfall: s(shortfall),
    claimableOwner: s(claimableOwner), claimableProvider: s(claimableProvider), seatOwner, rewardBalance: s(rewardBalance),
  };
}

export async function readFactory(client, factory) {
  const r = (functionName, args = []) => client.readContract({ address: factory, abi: FactoryAbi, functionName, args });
  const [collection, rewardToken, registrar, relayOrigin, count] = await Promise.all([r('collection'), r('rewardToken'), r('registrar'), r('relayOrigin'), r('count')]);
  return { collection, rewardToken, registrar, relayOrigin, count: Number(count) };
}

/// Provenance: was this address created by the pinned factory? The factory keeps its vaults in an array; the newest
/// entries are scanned first (agreements are few). Beyond `maxScan` entries the factory's VaultCreated logs are
/// used instead, from `fromBlock` (the factory's deployment block) on. Self-reported getters are never enough.
export async function isFactoryVault(client, factory, vault, { maxScan = 400, fromBlock = 0n } = {}) {
  const count = Number(await client.readContract({ address: factory, abi: FactoryAbi, functionName: 'count' }));
  if (count <= maxScan) {
    for (let i = count - 1; i >= 0; i--) {
      const a = await client.readContract({ address: factory, abi: FactoryAbi, functionName: 'vaults', args: [BigInt(i)] });
      if (lower(a) === lower(vault)) return true;
    }
    return false;
  }
  const logs = await client.getLogs({ address: factory, event: VAULT_CREATED, args: { vault: getAddress(vault) }, fromBlock: BigInt(fromBlock), toBlock: 'latest' });
  return logs.length > 0;
}

/// The exact binding of an agent on the registrar plus whether `account` controls it. `known: false` is the
/// registrar's own answer (no such agent); `null` means the registrar could not be read, which is never treated as
/// an absence (that would pay for a second registration).
export async function agentBinding(client, registrar, agentId, account) {
  let b;
  try {
    b = await client.readContract({ address: registrar, abi: registrarAbi, functionName: 'bindingOf', args: [BigInt(agentId)] });
  } catch (e) {
    const reverted = typeof e.walk === 'function' ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    if (reverted && reverted.data && reverted.data.errorName === 'UnknownAgent') return { known: false, tokenContract: null, tokenId: null, controller: false };
    return null;
  }
  let controller = false;
  try { controller = await client.readContract({ address: registrar, abi: registrarAbi, functionName: 'isController', args: [BigInt(agentId), account] }); } catch { return null; }
  return { known: true, tokenContract: b[1], tokenId: s(b[2]), controller };
}

/// true / false / null (unreadable): does this vault control an agent bound to exactly its seat?
export async function vaultControlsAgent(client, registrar, agentId, vault, collection, tokenId) {
  const b = await agentBinding(client, registrar, agentId, vault);
  if (!b) return null;
  return b.controller && lower(b.tokenContract) === lower(collection) && String(b.tokenId) === String(tokenId);
}

// ---------------------------------------------------------------- calldata for the wallet

const vaultCall = (functionName, args = []) => encodeFunctionData({ abi: SeatVaultAbi, functionName, args });

export const tx = {
  create: (factory, { provider, operator, tokenId, providerBps, deviceKey }) => ({
    to: factory,
    data: encodeFunctionData({ abi: FactoryAbi, functionName: 'create', args: [getAddress(provider), getAddress(operator), BigInt(tokenId), Number(providerBps), deviceKey] }),
  }),
  /// The deposit: the owner's safe transfer straight into the vault; the receiver hook records it. No approval needed.
  depositSeat: (collection, owner, vault, tokenId) => ({ to: collection, data: encodeFunctionData({ abi: erc721Abi, functionName: 'safeTransferFrom', args: [getAddress(owner), getAddress(vault), BigInt(tokenId)] }) }),
  syncHeld: (vault) => ({ to: vault, data: vaultCall('syncHeld') }),
  approvePairing: (vault, nonce, expiresAt, relayOrigin) => ({ to: vault, data: vaultCall('approvePairing', [nonce, BigInt(expiresAt), relayOrigin]) }),
  registerAgent: (vault, data) => ({ to: vault, data: vaultCall('registerAgent', [data]) }),
  claim: (vault) => ({ to: vault, data: vaultCall('claim') }),
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

/// AgentRegistered events of a vault from a block on (backfill after a restart).
export async function agentRegisteredSince(client, vault, fromBlock) {
  const logs = await client.getLogs({ address: vault, event: AGENT_REGISTERED, fromBlock: BigInt(fromBlock), toBlock: 'latest' });
  return logs.map((l) => ({ agentId: l.args.agentId.toString(), txHash: l.transactionHash, block: Number(l.blockNumber) }));
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
