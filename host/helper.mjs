#!/usr/bin/env node
// The host helper: a small program beside the worker. It talks to IMD, signs one pairing with the operator key, and
// hands the owner the strings to paste into the agreement page. Config: host/config.json. Env: OPERATOR_KEY (0x
// private key of the vault's operator; used only to sign the pairing digest; never printed).
//   node helper.mjs offer --provider 0x… --operator 0x… --device-key <64 hex> --bps 3000
//   node helper.mjs pair <vault>       start one attempt for that vault and run it to the end
//   node helper.mjs resume <vault>     continue the recorded attempt (after a restart, or a pending bind)
//   node helper.mjs status <vault>     print the vault and IMD's view of the seat
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseConfig } from './lib/config.js';
import { httpClient, readVault, formatUnits } from './lib/chain.js';
import { ImdApi } from './lib/imd.js';
import { Attempt } from './lib/attempt.js';
import { encodeOffer, validateHostingOffer, HOSTING_PREFIX } from './lib/pairing.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1]; };
const log = (m) => console.log(new Date().toISOString(), m);

export function fileStore(path) {
  return {
    load: () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null),
    save: (record) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(record, null, 1)); },
  };
}

function loadConfig() {
  const path = process.env.SEAT_HELPER_CONFIG || join(here, 'config.json');
  if (!existsSync(path)) { console.error(`no config at ${path}; copy config.example.json to config.json and fill it in`); process.exit(2); }
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}

function operatorAccount() {
  const key = process.env.OPERATOR_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) { console.error('OPERATOR_KEY (0x + 64 hex) must be in the environment for pair/resume'); process.exit(2); }
  return privateKeyToAccount(key);
}

async function main() {
  if (cmd === 'offer') {
    const config = loadConfig();
    const offer = { v: 1, provider: getAddress(flag('--provider')), operator: getAddress(flag('--operator')), deviceKey: '0x' + String(flag('--device-key', '')).replace(/^0x/, '').toLowerCase(), providerBps: Number(flag('--bps', 3000)), chainId: config.chainId, relayOrigin: config.relayOrigin, collection: config.collection };
    const problems = validateHostingOffer(offer, { chain: config.chainId, relay: config.relayOrigin, collection: config.collection });
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log(`Give this hosting offer to the owner (host share ${offer.providerBps / 100}%):\n\n${encodeOffer(HOSTING_PREFIX, offer)}\n`);
    return;
  }
  const vault = argv[1];
  if (!['pair', 'resume', 'status'].includes(cmd) || !/^0x[0-9a-fA-F]{40}$/.test(vault || '')) {
    console.error('usage: helper.mjs offer --provider 0x… --operator 0x… --device-key <hex> --bps 3000 | pair <vault> | resume <vault> | status <vault>');
    process.exit(2);
  }
  const config = loadConfig();
  const client = httpClient(config.rpcUrl);
  const imd = new ImdApi(config.imdApi);
  if (cmd === 'status') {
    const v = await readVault(client, getAddress(vault));
    console.log(JSON.stringify({ ...v, rewardBalance: formatUnits(v.rewardBalance, config.rewardDecimals), pending: formatUnits(v.pending, config.rewardDecimals), claimableOwner: formatUnits(v.claimableOwner, config.rewardDecimals), claimableProvider: formatUnits(v.claimableProvider, config.rewardDecimals) }, null, 1));
    console.log('IMD swarm entry:', JSON.stringify(await imd.swarmSeat(v.tokenId)));
    const st = await imd.seatStanding(v.tokenId);
    console.log('IMD standing:', st.status === 404 ? 'never paired' : JSON.stringify(st.json).slice(0, 400));
    return;
  }
  const operator = operatorAccount();
  const store = fileStore(join(process.env.SEAT_HELPER_DATA || join(here, 'data'), `${vault.toLowerCase()}.json`));
  const attempt = new Attempt({ config, client, imd, operator, store, vault: getAddress(vault), log });
  process.on('SIGINT', () => { attempt.cancel(); log('cancelled: nothing more will be sent; the record keeps what happened'); process.exit(130); });
  if (cmd === 'pair') {
    const offer = await attempt.start();
    console.log(`\nGive this pairing string to the owner now; the owner must approve it on chain within the code's life (about five minutes):\n\n${offer}\n`);
    log('waiting for the owner\'s approval on chain…');
  }
  const record = await attempt.resume();
  log(`done: phase ${record.phase}${record.agentId ? `, agent ${record.agentId}` : ''}`);
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
