// The committed bundle in a real browser (see browser-env.mjs): the wallet boundary (Codex R1, R5, R6), the step
// logic reached through the page (R2, R3), the storage guard, and the recovery rules from Codex's verification
// (F1 a mined hash leaves the ledger everywhere, F2 a receipt found after a reload reconstructs the approval or the
// registration, F3 a wallet prompt left open blocks other tabs for as long as it is open). Skips when Playwright is
// not installed (`npm i -D playwright` + `npx playwright install chromium`, or the machine's Chrome).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import { SeatVaultAbi } from '../../host/lib/chain.js';
import { skip, launch, serveDist, simulatedChain, openContext, pairingString, agentRegisteredLog, gateFirstSend, baseRecord, VAULT, FOREIGN } from './browser-env.mjs';

const noErrors = (...pages) => assert.deepEqual(pages.flatMap((p) => p.__errors), []);
const record = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('seat-page:1')));
const V = VAULT.toLowerCase();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 30_000) {
  const t0 = Date.now();
  for (;;) { if (await fn()) return; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await wait(200); }
}
/// the pasted string and its intent already in the record, the seat in the vault: ready to approve
const readyToApprove = (chain, extra = {}) => { const { text, artifact } = pairingString(chain, extra); return { record: { ...baseRecord(VAULT), artifactText: text, intents: { [V]: artifact.intent } }, artifact }; };
async function clickApprove(p) {
  await p.waitForSelector('[data-action=approvePairing]');
  await p.locator('[data-action=approvePairing]').click();
  await p.waitForSelector('#okBtn');
  await p.locator('#okBtn').click();
}
const sentToast = (p, title = 'Approve the pairing') => p.waitForFunction((t) => document.querySelector('#toast').textContent.includes(`${t}: sent`), title);

test('the bundle in a browser', { skip, timeout: 420_000 }, async (t) => {
  const browser = await launch();
  const site = await serveDist();
  try {
    await t.test('R1: an address the factory did not create is refused, pasted or restored, and never receives the NFT', async () => {
      const chain = simulatedChain();
      const { context, page } = await openContext(browser, site.base, chain);
      const p = await page();
      await p.locator('#connectMain').click();
      await p.getByRole('button', { name: 'Open an existing agreement', exact: true }).click();
      await p.locator('#dialogForm input[name=address]').fill(FOREIGN);
      await p.locator('#dialogForm button[type=submit]').click();
      await p.waitForFunction(() => document.querySelector('#toast').textContent.includes('not created by this factory'));
      assert.equal(await p.locator('[data-action=deposit]').count(), 0);
      await context.close();
      const restored = await openContext(browser, site.base, chain, { record: baseRecord(FOREIGN) });
      const p2 = await restored.page();
      await p2.waitForFunction(() => document.querySelector('#vaultBox').textContent.includes('refused: not made by this factory'));
      assert.equal(await p2.locator('[data-action]:not([data-action=create]):not([data-action=selectVault])').count(), 0, 'no agreement action is offered for the refused address');
      assert.equal(chain.sent.length, 0);
      noErrors(p, p2);
      await restored.context.close();
      // the factory's own vault is accepted and offers the deposit
      const ok = await openContext(browser, site.base, chain, { record: baseRecord(VAULT) });
      const p3 = await ok.page();
      await p3.waitForSelector('[data-action=deposit]');
      noErrors(p3);
      await ok.context.close();
    });

    await t.test('R5: a chain change between the review and the wallet request sends nothing', async () => {
      const chain = simulatedChain();
      const { context, page } = await openContext(browser, site.base, chain, { record: baseRecord(VAULT) });
      const p = await page();
      await p.waitForSelector('[data-action=deposit]');
      await p.locator('[data-action=deposit]').click();
      await p.waitForSelector('#okBtn');
      chain.chainId = '0xaa36a7';
      await p.evaluate(() => window.__emit('chainChanged', '0xaa36a7'));
      await p.locator('#okBtn').click();
      await p.waitForFunction(() => document.querySelector('#toast').textContent.includes('nothing was sent'));
      assert.equal(chain.sent.length, 0);
      noErrors(p);
      await context.close();
    });

    await t.test('R6 + F1: two tabs, one approval; the second is refused; once mined, the hash leaves the ledger in every tab', async () => {
      const chain = simulatedChain({ held: true, seatOwner: VAULT });
      const { context, page } = await openContext(browser, site.base, chain, readyToApprove(chain));
      const p1 = await page();
      const p2 = await page();
      await p1.waitForSelector('[data-action=approvePairing]');
      await p2.waitForSelector('[data-action=approvePairing]');
      await p1.locator('[data-action=approvePairing]').click();
      await p2.locator('[data-action=approvePairing]').click();
      await p1.waitForSelector('#okBtn');
      await p2.waitForSelector('#okBtn');
      await p1.locator('#okBtn').click();
      await sentToast(p1);
      assert.equal(chain.sent.length, 1);
      await p2.locator('#okBtn').click();
      await p2.waitForFunction(() => document.querySelector('#toast').textContent.includes('still unresolved'));
      assert.equal(chain.sent.length, 1, 'the second tab sent nothing');
      await p2.waitForFunction(() => document.querySelector('#main').textContent.includes('waiting to be mined'));
      const hash = chain.sent[0].hash;
      assert.deepEqual(Object.keys((await record(p2)).pending), [hash], 'the unresolved hash is kept, with its context');
      assert.equal((await record(p2)).pending[hash].action, 'approvePairing');
      // mined: settled once, resolved for both tabs, the second tab moves on to the registration by itself
      chain.mine(hash);
      await until(async () => Object.keys((await record(p1)).approved).length > 0, 'the approval to be recorded');
      for (const p of [p1, p2]) {
        const r = await record(p);
        assert.deepEqual(r.pending, {}, 'the mined hash is not pending anywhere');
        assert.equal(r.resolved[hash].status, 'success');
        assert.equal(r.approved[V].txHash, hash);
      }
      await p2.waitForSelector('[data-action=registerAgent]');
      await p1.waitForSelector('[data-action=registerAgent]');
      assert.equal((await record(p1)).log.filter((x) => /^approval .* mined$/.test(x.text)).length, 1, 'settled once, by one tab');
      noErrors(p1, p2);
      await context.close();
    });

    await t.test('F1: a reverted approval frees the ledger and the approval can be sent again', async () => {
      const chain = simulatedChain({ held: true, seatOwner: VAULT });
      const { context, page } = await openContext(browser, site.base, chain, readyToApprove(chain));
      const p = await page();
      await clickApprove(p);
      await sentToast(p);
      chain.mine(chain.sent[0].hash, [], { status: '0x0' });
      await p.waitForFunction(() => document.querySelector('#toast').textContent.includes('reverted'));
      await until(async () => Object.keys((await record(p)).pending).length === 0, 'the reverted hash to leave the ledger');
      const r = await record(p);
      assert.equal(r.resolved[chain.sent[0].hash].status, 'reverted');
      assert.equal(r.approved[V], undefined, 'a reverted approval is not an approval');
      await p.waitForSelector('[data-action=approvePairing]:not([disabled])');
      await clickApprove(p);
      await sentToast(p);
      assert.equal(chain.sent.length, 2, 'the retry was accepted');
      noErrors(p);
      await context.close();
    });

    await t.test('F2: the page closed before the approval mined; the receipt found after a reload reconstructs it, past every deadline', async () => {
      const chain = simulatedChain({ held: true, seatOwner: VAULT });
      const { record: seed, artifact } = readyToApprove(chain);
      const { context, page } = await openContext(browser, site.base, chain, { record: seed });
      const p = await page();
      await clickApprove(p);
      await sentToast(p);
      const hash = chain.sent[0].hash;
      await p.close();
      chain.mine(hash);
      // reopened long after the code and the signature expired; only the receipt exists
      await context.addInitScript(() => { const clock = Date.now.bind(Date); Date.now = () => clock() + 600_000; });
      const p2 = await page();
      await p2.waitForFunction(() => JSON.parse(localStorage.getItem('seat-page:1')).log.some((x) => /approval .* mined$/.test(x.text)), null, { timeout: 30_000 });
      await p2.waitForSelector('[data-action=registerAgent]', { timeout: 30_000 });
      const r = await record(p2);
      assert.equal(r.approved[V].txHash, hash);
      assert.equal(r.approved[V].digest, artifact.digest);
      assert.deepEqual(r.pending, {});
      // the same discipline for the registration: sent, page closed, mined with the event, found after a reload
      await p2.locator('[data-action=registerAgent]').click();
      await p2.waitForSelector('#okBtn');
      await p2.locator('#okBtn').click();
      await sentToast(p2, 'Register the agent');
      const regHash = chain.sent[1].hash;
      await p2.close();
      chain.mine(regHash, [agentRegisteredLog(51)]);
      const p3 = await page();
      await p3.waitForFunction(() => document.querySelector('h1').textContent.includes('Your side is done'), null, { timeout: 30_000 });
      const r3 = await record(p3);
      assert.deepEqual(r3.registered[V], { agentId: '51', txHash: regHash });
      assert.equal(r3.resolved[regHash].status, 'success');
      assert.deepEqual(r3.pending, {});
      noErrors(p2, p3);
      await context.close();
    });

    await t.test('F3: a wallet prompt left open blocks another tab for as long as it is open, not for a fixed time', async () => {
      const chain = simulatedChain({ held: true, seatOwner: VAULT });
      const gate = gateFirstSend(chain);
      const { context, page } = await openContext(browser, site.base, chain, readyToApprove(chain));
      const first = await page();
      const second = await page();
      await first.waitForSelector('[data-action=approvePairing]');
      await second.waitForSelector('[data-action=approvePairing]');
      await first.locator('[data-action=approvePairing]').click();
      await second.locator('[data-action=approvePairing]').click();
      await first.waitForSelector('#okBtn');
      await second.waitForSelector('#okBtn');
      await first.locator('#okBtn').click();
      await until(() => gate.sends() === 1, 'the first wallet request');
      await second.evaluate(() => { const clock = Date.now.bind(Date); Date.now = () => clock() + 95_000; });
      await second.locator('#okBtn').click();
      await second.waitForFunction(() => document.querySelector('#toast').textContent.includes('another tab'));
      assert.equal(gate.sends(), 1, 'the open prompt still owns the agreement');
      gate.release();
      await sentToast(first);
      assert.equal(chain.sent.length, 1);
      await until(async () => Object.keys((await record(second)).pending).length === 1, 'the second tab to learn of the hash');
      await second.waitForFunction(() => document.querySelector('#main').textContent.includes('waiting to be mined'));
      noErrors(first, second);
      await context.close();
    });

    await t.test('a tab closed while its wallet prompt was open leaves no hash; the approval live on the vault is evidence enough', async () => {
      const chain = simulatedChain({ held: true, seatOwner: VAULT });
      const gate = gateFirstSend(chain);
      const { context, page } = await openContext(browser, site.base, chain, readyToApprove(chain));
      const p = await page();
      await clickApprove(p);
      await until(() => gate.sends() === 1, 'the wallet request');
      await p.close(); // the tab is gone before the wallet answers; the lock is released with it
      gate.release();
      await until(() => chain.sent.length === 1, 'the wallet to send anyway');
      chain.mine(chain.sent[0].hash);
      const p2 = await page();
      await until(async () => !!(await record(p2)).approved[V], 'the approval to be recorded from the vault');
      const r = await record(p2);
      assert.equal(r.approved[V].source, 'chain');
      assert.deepEqual(r.pending, {}, 'no hash was ever recorded');
      await p2.waitForSelector('[data-action=registerAgent]');
      await p2.close();
      await context.addInitScript(() => { const clock = Date.now.bind(Date); Date.now = () => clock() + 600_000; });
      const p3 = await page();
      await p3.waitForSelector('[data-action=registerAgent]', { timeout: 30_000 });
      noErrors(p2, p3);
      await context.close();
    });

    await t.test('storage that refuses writes blocks an approval instead of forgetting it', async () => {
      const chain = simulatedChain({ held: true, seatOwner: VAULT });
      const { context, page } = await openContext(browser, site.base, chain, { ...readyToApprove(chain), denyStorage: true });
      const p = await page();
      await p.waitForSelector('[data-action=approvePairing]');
      await p.locator('[data-action=approvePairing]').click();
      await p.waitForSelector('#okBtn');
      await p.locator('#okBtn').click();
      await p.waitForFunction(() => document.querySelector('#toast').textContent.includes('cannot keep a record'));
      await p.waitForFunction(() => document.querySelector('#notes').textContent.includes('refuses to store'));
      assert.equal(chain.sent.length, 0);
      noErrors(p);
      await context.close();
    });

    await t.test('R2: an old listing with a reusable agent still asks for the new pairing first', async () => {
      const chain = simulatedChain({ held: true, seatOwner: VAULT, agentBound: 'vault' });
      const swarm = { seats: { 7: { tokenId: 7, agentId: '19', accepted: 300 } } };
      const { context, page } = await openContext(browser, site.base, chain, { record: baseRecord(VAULT), swarm });
      const p = await page();
      await p.waitForSelector('[data-action=pairing-offer]');
      assert.ok((await p.locator('h1').textContent()).includes('Approve the pairing'));
      assert.equal(await p.locator('[data-action=registerAgent]').count(), 0);
      noErrors(p);
      await context.close();
    });

    await t.test('R3: registration stays reachable after the pairing code expired, then the setup is done', async () => {
      const chain = simulatedChain({ held: true, seatOwner: VAULT });
      const { text, artifact } = pairingString(chain, { codeSeconds: 3 });
      const { context, page } = await openContext(browser, site.base, chain, { record: baseRecord(VAULT) });
      const p = await page();
      await p.waitForSelector('[data-action=pairing-offer]');
      await p.locator('[data-action=pairing-offer]').click();
      await p.locator('#dialogForm textarea[name=offer]').fill(text);
      await p.locator('#dialogForm button[type=submit]').click();
      await clickApprove(p);
      await sentToast(p);
      assert.equal(chain.sent.length, 1);
      chain.mine(chain.sent[0].hash);
      await p.waitForFunction(() => document.querySelector('#details').textContent.includes('code C0DE1'), null, { timeout: 60_000 });
      await wait(3500); // the code's deadline passes
      await p.waitForSelector('[data-action=registerAgent]', { timeout: 30_000 });
      const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('seat-page:1')).intents);
      assert.equal(Object.values(kept)[0].data, artifact.intent.data, 'the intent was kept apart from the expired string');
      await p.locator('[data-action=registerAgent]').click();
      await p.waitForSelector('#okBtn');
      await p.locator('#okBtn').click();
      await sentToast(p, 'Register the agent');
      assert.equal(chain.sent.length, 2);
      const reg = decodeFunctionData({ abi: SeatVaultAbi, data: chain.sent[1].data });
      assert.equal(reg.functionName, 'registerAgent');
      assert.equal(reg.args[0], artifact.intent.data);
      chain.mine(chain.sent[1].hash, [agentRegisteredLog(52)]);
      await p.waitForFunction(() => document.querySelector('h1').textContent.includes('Your side is done'), null, { timeout: 60_000 });
      assert.ok((await p.locator('#notes').textContent()).includes('Your host confirms'));
      assert.equal((await record(p)).registered[V].agentId, '52');
      noErrors(p);
      await context.close();
    });
  } finally {
    await site.close();
    await browser.close();
  }
});
