// A complete offline environment for the console: anvil with the real vault and factory bytecode plus the test
// mocks, a fake IMD, and the console server. Used by the end-to-end test and by the demo script.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startConsole } from '../server.mjs';
import { startFakeImd } from './fake-imd.mjs';
import { normalizeConfig } from '../lib/config.js';

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
export const DEVICE_KEY = 'ab'.repeat(32);
export const RELAY = 'https://relay.invalid';
export const mintAbi = parseAbi(['function mint(address to, uint256 id)', 'function mint(address to, uint256 amount)']);

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
export async function startAnvilEnv({ anvilPort = 8547, consolePort = 0, operatorKey = KEYS.operator, blockTime = 1 } = {}) {
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
  await pub.waitForTransactionReceipt({ hash: await wallets.owner.writeContract({ address: seats.address, abi: mintAbi, functionName: 'mint', args: [addr.owner, 1n] }) });
  const imd = await startFakeImd({ client: pub, chainId: 31337, collection: seats.address, registrar: registrar.address, relayOrigin: RELAY });
  const config = normalizeConfig({ chainId: 31337, rpcUrl: RPC, imdApi: imd.base, factory: factory.address, collection: seats.address, rewardToken: reward.address, registrar: registrar.address, relayOrigin: RELAY, pollMs: 2000, imdPollMs: 5000 });
  const dataDir = mkdtempSync(join(tmpdir(), 'seat-console-'));
  const console_ = await startConsole({ config, dataDir, operatorKey, port: consolePort });
  const base = `http://127.0.0.1:${console_.port}`;
  const api = async (path, body) => {
    const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    return j;
  };
  const stateIs = (pred, what) => waitFor(async () => { const s = await api('/api/state'); return pred(s) ? s : null; }, what, 90_000, 1000);
  // the page's pattern: build → the wallet sends → tell the console the hash
  const send = async (who, action, params = {}) => {
    const built = await api('/api/tx/build', { action, params });
    const hash = await wallets[who].sendTransaction({ to: built.to, data: built.data });
    await api('/api/tx/sent', { action, hash, from: addr[who] });
    return hash;
  };
  const mintReward = async (to, amount) => pub.waitForTransactionReceipt({ hash: await wallets.owner.writeContract({ address: reward.address, abi: mintAbi, functionName: 'mint', args: [to, BigInt(amount)] }) });
  const stop = async () => { await console_.close(); await imd.close(); anvil.kill(); };
  return { RPC, pub, wallets, addr, seats, reward, registrar, factory, imd, console: console_, base, api, stateIs, send, mintReward, stop };
}

/// Drives a fresh environment to a named stage: 'created' | 'deposited' | 'offered' | 'approved' | 'paired' | 'active'.
export async function driveTo(env, stage) {
  const { api, send, stateIs, addr } = env;
  const offer = await api('/api/hosting-offer/build', { provider: addr.host, operator: addr.operator, deviceKey: DEVICE_KEY, providerBps: 3000 });
  await api('/api/hosting-offer/import', { offer: offer.text });
  await send('owner', 'create', { tokenId: '1' });
  let s = await stateIs((x) => x.selectedVault && x.vault, 'vault selection');
  if (stage === 'created') return s;
  await send('owner', 'approveSeat');
  await stateIs((x) => x.vault.seatApproved && x.vault.seatApproved.toLowerCase() === x.vault.address.toLowerCase(), 'approval');
  await send('owner', 'deposit');
  s = await stateIs((x) => x.vault.held, 'deposit');
  if (stage === 'deposited') return s;
  const p = await api('/api/pairing/start', { deviceKey: DEVICE_KEY });
  await api('/api/pairing/import', { offer: p.offer });
  if (stage === 'offered') return api('/api/state');
  await send('owner', 'approvePairing');
  s = await stateIs((x) => x.vault.approvedDigest.toLowerCase() === p.artifact.digest.toLowerCase(), 'pairing approval');
  if (stage === 'approved') return s;
  await api('/api/pairing/complete', {});
  s = await stateIs((x) => x.derived.step === 'register', 'enrolment');
  if (stage === 'paired') return s;
  await api('/api/register/intent', {});
  await send('owner', 'registerAgent');
  return stateIs((x) => x.registration.bound === true, 'bind');
}
