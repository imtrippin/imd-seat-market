import test from 'node:test';
import assert from 'node:assert/strict';
import { startAnvilEnv, driveTo, haveArtifacts, waitFor } from './anvil-env.mjs';
import { startConsole } from '../server.mjs';

test('two consoles coordinate one automatic pairing, with no early IMD request', { skip: !haveArtifacts, timeout: 240000 }, async (t) => {
  const env = await startAnvilEnv({ anvilPort: 8549 });
  if (!env) { t.skip('anvil unavailable'); return; }
  let ownerConsole;
  try {
    const initial = await driveTo(env, 'deposited');
    ownerConsole = await startConsole({ config: env.config });
    const ownerApi = async (path, body) => {
      const r = await fetch(`http://127.0.0.1:${ownerConsole.port}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
    };
    await ownerApi('/api/vault', { address: initial.vault.address });
    const join = async (api, who) => {
      const c = await api('/api/setup/challenge', { account: env.addr[who] });
      await api('/api/setup/join', { nonce: c.nonce, signature: await env.wallets[who].account.signMessage({ message: c.message }) });
    };
    await join(env.api, 'host'); await join(ownerApi, 'owner');
    await assert.rejects(env.api('/api/pairing/start', {}), /Both people/);
    assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/start').length, 0);
    await env.api('/api/setup/arm', {});
    assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/start').length, 0);
    await ownerApi('/api/setup/ready', { ready: true, version: 0 });
    const offered = await waitFor(async () => {
      const s = await ownerApi('/api/state'); return s.pairing.artifact ? s : null;
    }, 'automatic offer shared to owner');
    assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/start').length, 1);
    assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/complete').length, 0);
    const built = await ownerApi('/api/tx/build', { action: 'approvePairing' });
    const hash = await env.wallets.owner.sendTransaction({ to: built.to, data: built.data });
    await ownerApi('/api/setup/pending', { hash, attemptId: offered.setup.room.attempt.id });
    await ownerApi('/api/tx/sent', { action: 'approvePairing', hash, from: env.addr.owner });
    const paired = await waitFor(async () => { const s = await env.api('/api/state'); return s.pairing.completed ? s : null; }, 'automatic completion');
    assert.equal(paired.setup.armedUntil, 0);
    assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/complete').length, 1);
    assert.equal(paired.setup.room.attempt.id, offered.setup.room.attempt.id);
    assert.ok(!JSON.stringify(paired.setup).includes('token"'));
    const forbidden = await fetch(`${env.base}/api/setup/arm`, { method: 'POST', headers: { origin: 'https://unrelated.invalid', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(forbidden.status, 403);
  } finally { if (ownerConsole) await ownerConsole.close(); await env.stop(); }
});
