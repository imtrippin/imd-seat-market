// A complete offline environment: anvil with the real vault and factory bytecode plus the test mocks, and a fake IMD
// that verifies pairings through ERC-1271 like the real one. The owner's actions are sent exactly as the page sends
// them (the same calldata builders); the host side runs the helper's Attempt in-process with a memory store.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startFakeImd } from './fake-imd.mjs';
import { normalizeConfig } from '../lib/config.js';
import { ImdApi } from '../lib/imd.js';

const here = dirname(fileURLToPath(import.meta.url));
export const OUT = join(here, '..', '..', 'contracts', 'out');
export const artifact = (file, name) => { const j = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object }; };
const localAnvil = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
export const anvilBin = existsSync(localAnvil) ? localAnvil : 'anvil';
export const haveArtifacts = existsSync(join(OUT, 'VaultMocks.sol', 'MockERC721.json')) && existsSync(join(OUT, 'SeatVault.sol', 'SeatVaultFactory.json'));

// anvil's first three default accounts
export const KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  host: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  operator: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
};
export const DEVICE_KEY = '0x' + 'ab'.repeat(32);
export const RELAY = 'https://relay.invalid';
export const mintAbi = parseAbi(['function mint(address to, uint256 id)', 'function mint(address to, uint256 amount)']);

export function memoryStore() {
  let record = null;
  return { load: () => (record ? JSON.parse(JSON.stringify(record)) : null), save: (r) => { record = JSON.parse(JSON.stringify(r)); } };
}

export async function waitFor(fn, what, ms = 60_000, every = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

/// Starts everything; returns null when anvil does not come up. `stop()` tears it all down.
export async function startAnvilEnv({ anvilPort = 8547, blockTime = 1 } = {}) {
  const RPC = `http://127.0.0.1:${anvilPort}`;
  const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const anvil = spawn(anvilBin, ['--port', String(anvilPort), '--silent', '--block-time', String(blockTime)], { stdio: 'ignore' });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const up = await waitFor(async () => { try { await pub.getChainId(); return true; } catch { return false; } }, 'anvil', 30_000, 300).catch(() => false);
  if (!up) { anvil.kill(); return null; }
  const wallets = Object.fromEntries(Object.entries(KEYS).map(([k, key]) => [k, createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) })]));
  const addr = Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, w.account.address]));
  const deploy = async (who, file, name, args = []) => {
    const a = artifact(file, name);
    const hash = await wallets[who].deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    return { address: r.contractAddress, abi: a.abi };
  };
  const seats = await deploy('owner', 'VaultMocks.sol', 'MockERC721');
  const reward = await deploy('owner', 'Mocks.sol', 'MockERC20');
  const registrar = await deploy('owner', 'VaultMocks.sol', 'MockRegistrar');
  const factory = await deploy('owner', 'SeatVault.sol', 'SeatVaultFactory', [seats.address, reward.address, registrar.address, RELAY]);
  const mintSeat = async (to, id) => pub.waitForTransactionReceipt({ hash: await wallets.owner.writeContract({ address: seats.address, abi: mintAbi, functionName: 'mint', args: [to, BigInt(id)] }) });
  await mintSeat(addr.owner, 1);
  const imd = await startFakeImd({ client: pub, chainId: 31337, collection: seats.address, registrar: registrar.address, relayOrigin: RELAY });
  const config = normalizeConfig({ chainId: 31337, rpcUrl: RPC, imdApi: imd.base, factory: factory.address, collection: seats.address, rewardToken: reward.address, registrar: registrar.address, relayOrigin: RELAY });
  const imdApi = new ImdApi(imd.base);
  /// the page's pattern: a prepared {to, data} sent from the role's wallet, mined before returning
  const send = async (who, built) => {
    const hash = await wallets[who].sendTransaction({ to: built.to, data: built.data });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${who} transaction reverted`);
    return { hash, receipt };
  };
  const mintReward = async (to, amount) => pub.waitForTransactionReceipt({ hash: await wallets.owner.writeContract({ address: reward.address, abi: mintAbi, functionName: 'mint', args: [to, BigInt(amount)] }) });
  const stop = async () => { await imd.close(); anvil.kill(); };
  return { RPC, pub, wallets, addr, seats, reward, registrar, factory, imd, imdApi, config, send, mintSeat, mintReward, operator: wallets.operator.account, stop };
}
