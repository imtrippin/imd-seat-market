// End to end, offline: the owner's transactions sent exactly as the page builds them, the host helper's attempt
// run in-process (including a restart in the middle and a lost completion answer), a fake IMD that verifies the
// pairing through ERC-1271, rewards claimed by both parties, exit, a claim after exit, an agreement that reuses an
// existing agent, and the refusal of a vault the factory did not create.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAbi } from 'viem';
import { startAnvilEnv, haveArtifacts, memoryStore, waitFor, artifact as loadArtifact, DEVICE_KEY, RELAY } from './anvil-env.mjs';
import { readVault, tx, decodeLogs, workerAuthorizationDigest, vaultControlsAgent, isFactoryVault } from '../lib/chain.js';
import { decodeOffer, validateHostingOffer, checkPairingOfferAgainstVault, encodeOffer, HOSTING_PREFIX, PAIRING_PREFIX } from '../lib/pairing.js';
import { derive } from '../lib/steps.js';
import { Attempt } from '../lib/attempt.js';

const skip = !haveArtifacts ? 'no Foundry artifacts (run forge build in contracts/)' : false;
const primary = (list) => list.filter((a) => !a.passive && !a.secondary).map((a) => a.id);

/// What the page derives: chain reads, IMD's open listing, the pasted string and the owner's own records.
async function pageView(env, vault, rec = {}) {
  const v = await readVault(env.pub, vault);
  const imdSeat = await env.imdApi.swarmSeat(v.tokenId);
  const agentReusable = imdSeat && imdSeat.agentId ? await vaultControlsAgent(env.pub, env.config.registrar, imdSeat.agentId, vault, env.config.collection, v.tokenId) : null;
  return { v, derived: derive({ artifact: null, approved: null, intent: null, registered: null, pendingHashes: [], ...rec, vault: v, imdSeat, agentReusable }) };
}

async function createVault(env, hostingOfferText, tokenId) {
  const offer = decodeOffer(HOSTING_PREFIX, hostingOfferText);
  assert.deepEqual(validateHostingOffer(offer, { chain: env.config.chainId, relay: env.config.relayOrigin, collection: env.config.collection }), []);
  const { receipt } = await env.send('owner', tx.create(env.config.factory, { provider: offer.provider, operator: offer.operator, tokenId, providerBps: offer.providerBps, deviceKey: offer.deviceKey }));
  const created = decodeLogs(receipt).find((e) => e.name === 'VaultCreated');
  assert.ok(created, 'the page reads the vault address from the VaultCreated event');
  return created.args.vault;
}

const hostingOfferFor = (env, bps) => encodeOffer(HOSTING_PREFIX, { v: 1, provider: env.addr.host, operator: env.addr.operator, deviceKey: DEVICE_KEY, providerBps: bps, chainId: env.config.chainId, relayOrigin: env.config.relayOrigin, collection: env.config.collection });

test('one agreement from creation to exit: four owner transactions, the helper restarts, completes and binds', { skip, timeout: 300_000 }, async (t) => {
  const env = await startAnvilEnv({ anvilPort: 8547 });
  if (!env) { t.skip('anvil did not start (is Foundry installed?)'); return; }
  const { addr, config, imd } = env;
  try {
    assert.equal(derive({ vault: null }).step, 'create');
    // 1. create
    const vault = await createVault(env, hostingOfferFor(env, 3000), '1');
    assert.equal(await isFactoryVault(env.pub, config.factory, vault), true);
    let view = await pageView(env, vault);
    assert.equal(view.derived.step, 'deposit');
    assert.deepEqual(primary(view.derived.owner), ['deposit']);
    // 2. move the NFT in: one safe transfer, no approval, no separate deposit call
    await env.send('owner', tx.depositSeat(config.collection, addr.owner, vault, '1'));
    view = await pageView(env, vault);
    assert.equal(view.v.held, true);
    assert.equal(view.derived.step, 'pair');
    assert.deepEqual(primary(view.derived.owner), ['pairing-offer']);
    // host: pair <vault> (start), then the helper is restarted before the owner approves
    const store = memoryStore();
    const first = new Attempt({ config, client: env.pub, imd: env.imdApi, operator: env.operator, store, vault, pollMs: 500 });
    const pairingText = await first.start();
    assert.match(pairingText, /^seatpair1:/);
    await assert.rejects(first.start(), /already in progress/);
    assert.equal(imd.state.calls.filter((c) => c.path === '/pair/start').length, 1);
    // owner: paste the string; the page checks it against the vault, recomputes the digest, keeps the intent apart
    const artifact = decodeOffer(PAIRING_PREFIX, pairingText);
    assert.deepEqual(checkPairingOfferAgainstVault(artifact, view.v, config), []);
    assert.equal((await workerAuthorizationDigest(env.pub, vault, artifact.message.deviceKey, artifact.message.nonce, artifact.message.expiresAt)).toLowerCase(), artifact.digest.toLowerCase());
    assert.ok(artifact.intent && artifact.intent.to.toLowerCase() === config.registrar.toLowerCase(), 'the registration intent travels with the pairing string');
    view = await pageView(env, vault, { artifact, intent: artifact.intent });
    assert.deepEqual(primary(view.derived.owner), ['approvePairing']);
    // 3. approve the pairing; meanwhile the helper restarts from its record
    const resumed = new Attempt({ config, client: env.pub, imd: env.imdApi, operator: env.operator, store, vault, pollMs: 500 });
    const run = resumed.resume();
    await env.send('owner', tx.approvePairing(vault, artifact.message.nonce, artifact.message.expiresAt, artifact.message.relayOrigin));
    const approved = { digest: artifact.digest, code: artifact.code };
    view = await pageView(env, vault, { artifact, intent: artifact.intent, approved });
    assert.equal(view.v.approvedDigest.toLowerCase(), artifact.digest.toLowerCase());
    assert.equal(view.derived.step, 'register', 'the owner approved; no agent exists yet');
    assert.deepEqual(primary(view.derived.owner), ['registerAgent']);
    await waitFor(() => resumed.record.phase === 'completed', 'the helper to complete the pairing', 60_000);
    assert.equal(imd.state.calls.filter((c) => c.path === '/pair/complete').length, 1);
    // 4. register through the vault (the string may have expired by now; the kept intent is what matters)
    const { receipt: regReceipt } = await env.send('owner', tx.registerAgent(vault, artifact.intent.data));
    const registered = { agentId: decodeLogs(regReceipt).find((e) => e.name === 'AgentRegistered').args.agentId, txHash: regReceipt.transactionHash };
    const record = await run;
    assert.equal(record.phase, 'done');
    assert.equal(record.agentId, '1');
    assert.ok(imd.state.calls.some((c) => c.path === '/agents/bind' && c.body.agentId === '1'));
    view = await pageView(env, vault, { approved, intent: artifact.intent, registered });
    assert.equal(view.derived.step, 'done');
    assert.ok(view.derived.notes[0].includes('Your host confirms'), 'the page never claims the device is paired');
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
    await env.mintReward(vault, 10);
    view = await pageView(env, vault);
    assert.ok(view.derived.host.some((a) => a.id === 'claim'), 'the host can still claim after the exit');
    await env.send('host', tx.claim(vault));
    assert.equal(await bal('host'), 33n);
  } finally {
    await env.stop();
  }
});

test('an existing agent is reused (three owner transactions), a lost completion answer is reconciled, a foreign vault is refused', { skip, timeout: 300_000 }, async (t) => {
  const env = await startAnvilEnv({ anvilPort: 8548 });
  if (!env) { t.skip('anvil did not start (is Foundry installed?)'); return; }
  const { addr, config, imd } = env;
  try {
    // R1: a SeatVault deployed by hand, answering every getter like a real one, is not the factory's
    await env.mintSeat(addr.owner, 3);
    const sv = loadArtifact('SeatVault.sol', 'SeatVault');
    const hash = await env.wallets.owner.deployContract({ abi: sv.abi, bytecode: sv.bytecode, args: [addr.owner, addr.host, addr.operator, config.collection, 3n, config.rewardToken, 3000, DEVICE_KEY, config.registrar, RELAY] });
    const foreign = (await env.pub.waitForTransactionReceipt({ hash })).contractAddress;
    assert.equal(await isFactoryVault(env.pub, config.factory, foreign), false);
    await env.send('owner', tx.depositSeat(config.collection, addr.owner, foreign, '3'));
    const stray = new Attempt({ config, client: env.pub, imd: env.imdApi, operator: env.operator, store: memoryStore(), vault: foreign, pollMs: 500 });
    await assert.rejects(stray.start(), /not a vault created by the configured factory/);
    // the reuse branch: the agent was registered earlier by the owner's own wallet
    await env.mintSeat(addr.owner, 2);
    const registerAbi = parseAbi(['function register(uint8 standard, address tokenContract, uint256 tokenId, string agentURI) returns (uint256)']);
    await env.pub.waitForTransactionReceipt({ hash: await env.wallets.owner.writeContract({ address: env.registrar.address, abi: registerAbi, functionName: 'register', args: [0, config.collection, 2n, 'ipfs://earlier'] }) });
    imd.state.seats.set('2', { agentId: '1' }); // IMD already knows that agent for the seat
    const vault = await createVault(env, hostingOfferFor(env, 2500), '2');
    await env.send('owner', tx.depositSeat(config.collection, addr.owner, vault, '2'));
    assert.equal(await vaultControlsAgent(env.pub, config.registrar, '1', vault, config.collection, '2'), true, 'control of the agent followed the seat into the vault');
    // the page still requires the new pairing although IMD lists an agent
    let view = await pageView(env, vault);
    assert.equal(view.derived.step, 'pair');
    // the helper: no intent fetched; the completion's answer is lost the first time (R4)
    let lose = true;
    const flaky = Object.create(env.imdApi);
    flaky.completePairing = async (body) => { const r = await env.imdApi.completePairing(body); if (lose) { lose = false; throw new Error('socket hang up'); } return r; };
    const store = memoryStore();
    const attempt = new Attempt({ config, client: env.pub, imd: flaky, operator: env.operator, store, vault, pollMs: 500 });
    const pairingText = await attempt.start();
    const artifact = decodeOffer(PAIRING_PREFIX, pairingText);
    assert.equal(artifact.agentId, '1');
    assert.equal(artifact.intent, null, 'no registration intent when the agent is reused');
    assert.equal(imd.state.calls.filter((c) => c.path === '/agents/register-intent').length, 0);
    await env.send('owner', tx.approvePairing(vault, artifact.message.nonce, artifact.message.expiresAt, artifact.message.relayOrigin));
    await assert.rejects(attempt.resume(), /no answer came back/);
    assert.equal(store.load().phase, 'completing');
    assert.equal(imd.state.calls.filter((c) => c.path === '/pair/complete').length, 1);
    // resume asks IMD what happened, never posts again, then binds the reused agent and finishes
    const again = new Attempt({ config, client: env.pub, imd: env.imdApi, operator: env.operator, store, vault, pollMs: 500 });
    const record = await again.resume();
    assert.equal(imd.state.calls.filter((c) => c.path === '/pair/complete').length, 1, 'the completion was posted exactly once');
    assert.equal(record.completion.status, 'reconciled');
    assert.equal(record.phase, 'done');
    assert.equal(record.agentId, '1');
    assert.ok(imd.state.calls.some((c) => c.path === '/agents/bind' && c.body.agentId === '1'));
    view = await pageView(env, vault, { approved: { digest: artifact.digest, code: artifact.code } });
    assert.equal(view.derived.step, 'done', 'reusable agent: no registration step');
  } finally {
    await env.stop();
  }
});
