// End to end, offline: a local anvil chain with the real vault and factory bytecode and the test mocks, a fake IMD
// that verifies pairings through ERC-1271 like the real one, and the console server driven the way the page
// drives it (build → wallet sends → sent). Skips when anvil or the Foundry artifacts are missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAbi } from 'viem';
import { startAnvilEnv, haveArtifacts, DEVICE_KEY } from './anvil-env.mjs';

const primary = (list) => list.filter((a) => !a.passive && !a.secondary).map((a) => a.id);

test('the console walks one agreement from creation to exit against anvil and a fake IMD', { skip: !haveArtifacts ? 'no Foundry artifacts (run forge build in contracts/)' : false, timeout: 240_000 }, async (t) => {
  const env = await startAnvilEnv({ anvilPort: 8547 });
  if (!env) { t.skip('anvil did not start (is Foundry installed?)'); return; }
  const { api, send, stateIs, addr, pub, reward, registrar, imd } = env;
  try {
    // 1. offer and create
    const offer = await api('/api/hosting-offer/build', { provider: addr.host, operator: addr.operator, deviceKey: DEVICE_KEY, providerBps: 3000 });
    assert.match(offer.text, /^seathost1:/);
    await api('/api/hosting-offer/import', { offer: offer.text });
    let s = await api('/api/state');
    assert.equal(s.derived.step, 'create');
    await send('owner', 'create', { tokenId: '1' });
    s = await stateIs((x) => x.selectedVault && x.vault, 'the vault to be selected from the VaultCreated event');
    assert.equal(s.derived.step, 'deposit');
    assert.equal(s.vault.provider.toLowerCase(), addr.host.toLowerCase());
    // 2. deposit
    assert.deepEqual(primary(s.derived.owner), ['approveSeat', 'deposit']);
    await send('owner', 'approveSeat');
    await stateIs((x) => x.vault.seatApproved && x.vault.seatApproved.toLowerCase() === x.vault.address.toLowerCase(), 'the approval');
    await send('owner', 'deposit');
    s = await stateIs((x) => x.vault.held, 'the deposit');
    assert.equal(s.derived.step, 'pair');
    await assert.rejects(api('/api/pairing/complete', {}), /no pairing in progress/);
    // 3. pairing: host starts, owner imports and approves, host completes with the server-side operator key
    // the manual path: nobody joined a setup room, the host hands the owner the offer string
    let s0 = await api('/api/state');
    assert.equal(s0.setup.room, null);
    const p = await api('/api/pairing/start', { deviceKey: DEVICE_KEY });
    assert.match(p.offer, /^seatpair1:/);
    await api('/api/pairing/import', { offer: p.offer });
    await assert.rejects(api('/api/pairing/complete', {}), /not approved this digest/);
    // hold the owner's approval unmined: no fresh code may be requested, even after re-importing the same offer
    const startsBefore = imd.state.calls.filter((c) => c.path === '/pair/start').length;
    await pub.request({ method: 'anvil_setIntervalMining', params: [0] });
    await pub.request({ method: 'anvil_setAutomine', params: [false] });
    await send('owner', 'approvePairing');
    s = await stateIs((x) => x.pairing.pendingHashes.length === 1, 'the approval to be recorded as pending');
    await assert.rejects(api('/api/pairing/start', { deviceKey: DEVICE_KEY }), /unresolved/);
    await api('/api/pairing/import', { offer: p.offer });
    s = await api('/api/state');
    assert.equal(s.pairing.pendingHashes.length, 1, 're-importing the offer keeps the unresolved approval');
    await assert.rejects(api('/api/pairing/start', { deviceKey: DEVICE_KEY }), /unresolved/);
    assert.equal(imd.state.calls.filter((c) => c.path === '/pair/start').length, startsBefore, 'no code was requested while the approval was pending');
    await pub.request({ method: 'anvil_setAutomine', params: [true] });
    await pub.request({ method: 'anvil_mine', params: ['0x1'] });
    await pub.request({ method: 'anvil_setIntervalMining', params: [1] });
    s = await stateIs((x) => x.vault.approvedDigest.toLowerCase() === p.artifact.digest.toLowerCase(), 'the pairing approval');
    assert.deepEqual(primary(s.derived.host), ['pairing-complete']);
    s = await stateIs((x) => x.pairing.pendingHashes.length === 0, 'the approval hash to be pruned once mined');
    assert.equal(s.setup.room, null, 'still no room: the manual path handled the whole pairing');
    const done = await api('/api/pairing/complete', {});
    assert.equal(done.completed, true);
    assert.ok(imd.state.calls.some((c) => c.path === '/pair/complete'));
    s = await stateIs((x) => x.derived.step === 'register', 'IMD to show the enrolment');
    // 4. registration through the vault, then the bind
    const reg = await api('/api/register/intent', {});
    assert.equal(reg.intent.to.toLowerCase(), registrar.address.toLowerCase());
    await send('owner', 'registerAgent');
    s = await stateIs((x) => x.registration.bound === true, 'the agent to be registered and bound');
    assert.equal(s.registration.agentId, '1');
    assert.equal(s.derived.step, 'active');
    // 5. rewards: 100 arrive, the host settles and claims 30, the owner claims 70
    await env.mintReward(s.vault.address, 100);
    s = await stateIs((x) => x.vault.pending === '100', 'the reward to show as pending');
    assert.ok(s.derived.host.some((a) => a.id === 'claim'));
    await send('host', 'settle');
    await stateIs((x) => x.vault.claimableProvider === '30', 'the settlement');
    await send('host', 'claim');
    await stateIs((x) => x.vault.claimableProvider === '0', 'the host claim');
    await send('owner', 'claim');
    s = await stateIs((x) => x.vault.rewardBalance === '0', 'the owner claim');
    const bal = (who) => pub.readContract({ address: reward.address, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [addr[who]] });
    assert.equal(await bal('host'), 30n);
    assert.equal(await bal('owner'), 70n);
    // 6. exit: the owner ends and takes the seat back
    await send('owner', 'end');
    s = await stateIs((x) => x.vault.ended, 'the end');
    assert.equal(s.derived.step, 'exit');
    await send('owner', 'withdraw', { to: addr.owner });
    s = await stateIs((x) => x.vault.seatOwner.toLowerCase() === addr.owner.toLowerCase(), 'the withdrawal');
    assert.equal(s.derived.statuses.at(-1).status, 'done');
    assert.ok(s.log.some((l) => l.text.includes('VaultCreated')) && s.log.some((l) => l.text.includes('agent 1 registered')));
  } finally {
    await env.stop();
  }
});
