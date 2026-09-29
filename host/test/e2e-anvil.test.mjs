// End to end, offline: the owner's four transactions sent exactly as the page builds them, the host helper's attempt
// run in-process (including a restart in the middle), a fake IMD that verifies the pairing through ERC-1271, rewards
// claimed by both parties, exit, and a claim after exit. A second agreement reuses an agent that already exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAbi } from 'viem';
import { startAnvilEnv, haveArtifacts, memoryStore, waitFor, DEVICE_KEY } from './anvil-env.mjs';
import { readVault, tx, decodeLogs, workerAuthorizationDigest, vaultControlsAgent } from '../lib/chain.js';
import { decodeOffer, validateHostingOffer, checkPairingOfferAgainstVault, encodeOffer, HOSTING_PREFIX, PAIRING_PREFIX } from '../lib/pairing.js';
import { derive } from '../lib/steps.js';
import { Attempt } from '../lib/attempt.js';

const skip = !haveArtifacts ? 'no Foundry artifacts (run forge build in contracts/)' : false;

/// What the page derives for a vault: chain reads plus IMD's open swarm listing plus the pasted string.
async function pageView(env, vault, { artifact = null, pendingHashes = [] } = {}) {
  const v = await readVault(env.pub, vault);
  const imdSeat = await env.imdApi.swarmSeat(v.tokenId);
  const agentReusable = imdSeat && imdSeat.agentId ? await vaultControlsAgent(env.pub, env.config.registrar, imdSeat.agentId, vault) : null;
  return { v, derived: derive({ vault: v, imdSeat, artifact, pendingHashes, agentReusable }) };
}

async function createVault(env, hostingOfferText, tokenId) {
  const offer = decodeOffer(HOSTING_PREFIX, hostingOfferText);
  assert.deepEqual(validateHostingOffer(offer, { chain: env.config.chainId, relay: env.config.relayOrigin, collection: env.config.collection }), []);
  const { receipt } = await env.send('owner', tx.create(env.config.factory, { provider: offer.provider, operator: offer.operator, tokenId, providerBps: offer.providerBps, deviceKey: offer.deviceKey }));
  const created = decodeLogs(receipt).find((e) => e.name === 'VaultCreated');
  assert.ok(created, 'the page reads the vault address from the VaultCreated event');
  return created.args.vault;
}

test('one agreement from creation to exit: four owner transactions, the helper completes and binds', { skip, timeout: 240_000 }, async (t) => {
  const env = await startAnvilEnv({ anvilPort: 8547 });
  if (!env) { t.skip('anvil did not start (is Foundry installed?)'); return; }
  const { addr, config, imd } = env;
  try {
    // the host's hosting offer (helper: offer)
    const hostingOffer = encodeOffer(HOSTING_PREFIX, { v: 1, provider: addr.host, operator: addr.operator, deviceKey: DEVICE_KEY, providerBps: 3000, chainId: config.chainId, relayOrigin: config.relayOrigin, collection: config.collection });
    assert.equal(derive({ vault: null }).step, 'create');
    // 1. create
    const vault = await createVault(env, hostingOffer, '1');
    let view = await pageView(env, vault);
    assert.equal(view.derived.step, 'deposit');
    assert.deepEqual(view.derived.owner.filter((a) => !a.passive && !a.secondary).map((a) => a.id), ['deposit']);
    // 2. move the NFT in: one safe transfer, no approval, no separate deposit call
    await env.send('owner', tx.depositSeat(config.collection, addr.owner, vault, '1'));
    view = await pageView(env, vault);
    assert.equal(view.v.held, true);
    assert.equal(view.derived.step, 'pair');
    assert.deepEqual(view.derived.owner.filter((a) => !a.passive && !a.secondary).map((a) => a.id), ['pairing-offer']);
    // host: pair <vault> (start), then the helper is restarted before the owner approves
    const store = memoryStore();
    const first = new Attempt({ config, client: env.pub, imd: env.imdApi, operator: env.operator, store, vault, pollMs: 500 });
    const pairingText = await first.start();
    assert.match(pairingText, /^seatpair1:/);
    await assert.rejects(first.start(), /already in progress/);
    assert.equal(imd.state.calls.filter((c) => c.path === '/pair/start').length, 1);
    // owner: paste the string; the page checks it against the vault and recomputes the digest
    const artifact = decodeOffer(PAIRING_PREFIX, pairingText);
    assert.deepEqual(checkPairingOfferAgainstVault(artifact, view.v, config), []);
    assert.equal((await workerAuthorizationDigest(env.pub, vault, artifact.message.deviceKey, artifact.message.nonce, artifact.message.expiresAt)).toLowerCase(), artifact.digest.toLowerCase());
    assert.ok(artifact.intent && artifact.intent.to.toLowerCase() === config.registrar.toLowerCase(), 'the registration intent travels with the pairing string');
    view = await pageView(env, vault, { artifact });
    assert.deepEqual(view.derived.owner.filter((a) => !a.passive && !a.secondary).map((a) => a.id), ['approvePairing']);
    // a pending approval blocks a second one on the page
    assert.equal(derive({ vault: view.v, imdSeat: null, artifact, pendingHashes: ['0x' + '11'.repeat(32)] }).owner.filter((a) => !a.passive).map((a) => a.id).includes('approvePairing'), false);
    // 3. approve the pairing; meanwhile the helper restarts from its record
    const resumed = new Attempt({ config, client: env.pub, imd: env.imdApi, operator: env.operator, store, vault, pollMs: 500 });
    const run = resumed.resume();
    await env.send('owner', tx.approvePairing(vault, artifact.message.nonce, artifact.message.expiresAt, artifact.message.relayOrigin));
    view = await pageView(env, vault, { artifact });
    assert.equal(view.v.approvedDigest.toLowerCase(), artifact.digest.toLowerCase());
    // the helper completes the pairing and waits for the registration
    await waitFor(() => resumed.record.phase === 'completed', 'the helper to complete the pairing', 60_000);
    assert.equal(imd.state.calls.filter((c) => c.path === '/pair/complete').length, 1);
    view = await pageView(env, vault, { artifact });
    assert.equal(view.derived.step, 'register', 'IMD lists the seat, no agent yet');
    assert.deepEqual(view.derived.owner.filter((a) => !a.passive && !a.secondary).map((a) => a.id), ['registerAgent']);
    // 4. register through the vault; the helper sees the event, binds, and finishes
    await env.send('owner', tx.registerAgent(vault, artifact.intent.data));
    const record = await run;
    assert.equal(record.phase, 'done');
    assert.equal(record.agentId, '1');
    assert.ok(imd.state.calls.some((c) => c.path === '/agents/bind' && c.body.agentId === '1'));
    view = await pageView(env, vault, { artifact });
    assert.equal(view.derived.step, 'hosted');
    // rewards: 100 arrive; the host claims 30 with the provider wallet, the owner 70; nobody needs settle
    await env.mintReward(vault, 100);
    view = await pageView(env, vault);
    assert.ok(view.derived.host.some((a) => a.id === 'claim') && view.derived.owner.some((a) => a.id === 'claim'));
    await env.send('host', tx.claim(vault));
    await env.send('owner', tx.claim(vault));
    const bal = (who) => env.pub.readContract({ address: env.reward.address, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [addr[who]] });
    assert.equal(await bal('host'), 30n);
    assert.equal(await bal('owner'), 70n);
    // exit, then a late reward is still claimable by both after the NFT left
    await env.send('owner', tx.withdraw(vault, addr.owner));
    view = await pageView(env, vault);
    assert.equal(view.derived.step, 'exit');
    assert.equal(view.derived.statuses.at(-1).status, 'done');
    assert.equal(view.v.seatOwner.toLowerCase(), addr.owner.toLowerCase());
    await env.mintReward(vault, 10);
    view = await pageView(env, vault);
    assert.ok(view.derived.host.some((a) => a.id === 'claim'), 'the host can still claim after the exit');
    await env.send('host', tx.claim(vault));
    assert.equal(await bal('host'), 33n);
  } finally {
    await env.stop();
  }
});

test('a seat whose agent already exists is reused: three owner transactions, no registration', { skip, timeout: 240_000 }, async (t) => {
  const env = await startAnvilEnv({ anvilPort: 8548 });
  if (!env) { t.skip('anvil did not start (is Foundry installed?)'); return; }
  const { addr, config, imd } = env;
  try {
    await env.mintSeat(addr.owner, 2);
    // the agent was registered earlier by the owner's own wallet (a previous holder can register the same way)
    const registerAbi = parseAbi(['function register(uint8 standard, address tokenContract, uint256 tokenId, string agentURI) returns (uint256)']);
    const hash = await env.wallets.owner.writeContract({ address: env.registrar.address, abi: registerAbi, functionName: 'register', args: [0, config.collection, 2n, 'ipfs://earlier'] });
    await env.pub.waitForTransactionReceipt({ hash });
    imd.state.seats.set('2', { agentId: '1' }); // IMD already knows that agent for the seat
    const hostingOffer = encodeOffer(HOSTING_PREFIX, { v: 1, provider: addr.host, operator: addr.operator, deviceKey: DEVICE_KEY, providerBps: 2500, chainId: config.chainId, relayOrigin: config.relayOrigin, collection: config.collection });
    const vault = await createVault(env, hostingOffer, '2');
    await env.send('owner', tx.depositSeat(config.collection, addr.owner, vault, '2'));
    assert.equal(await vaultControlsAgent(env.pub, config.registrar, '1', vault), true, 'control of the agent followed the seat into the vault');
    const store = memoryStore();
    const attempt = new Attempt({ config, client: env.pub, imd: env.imdApi, operator: env.operator, store, vault, pollMs: 500 });
    const pairingText = await attempt.start();
    const artifact = decodeOffer(PAIRING_PREFIX, pairingText);
    assert.equal(artifact.agentId, '1');
    assert.equal(artifact.intent, null, 'no registration intent when the agent is reused');
    assert.equal(imd.state.calls.filter((c) => c.path === '/agents/register-intent').length, 0);
    const run = attempt.resume();
    await env.send('owner', tx.approvePairing(vault, artifact.message.nonce, artifact.message.expiresAt, artifact.message.relayOrigin));
    const record = await run;
    assert.equal(record.phase, 'done');
    assert.equal(record.agentId, '1');
    assert.ok(imd.state.calls.some((c) => c.path === '/agents/bind' && c.body.agentId === '1'));
    const view = await pageView(env, vault, { artifact });
    assert.equal(view.derived.step, 'hosted');
  } finally {
    await env.stop();
  }
});
