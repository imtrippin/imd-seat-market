// The committed bundle in a real browser (see browser-env.mjs): the wallet boundary (Codex R1, R5, R6), the step
// logic reached through the page (R2, R3), and the storage guard. Skips when Playwright is not installed
// (`npm i -D playwright` + `npx playwright install chromium`, or the machine's Chrome).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import { SeatVaultAbi } from '../../host/lib/chain.js';
import { skip, launch, serveDist, simulatedChain, openContext, pairingString, baseRecord, VAULT, FOREIGN } from './browser-env.mjs';

const noErrors = (...pages) => assert.deepEqual(pages.flatMap((p) => p.__errors), []);

test('the bundle in a browser', { skip, timeout: 240_000 }, async (t) => {
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

    await t.test('R6: two tabs, one approval; the second tab learns of the first and is refused', async () => {
      const chain = simulatedChain({ held: true, seatOwner: VAULT });
      const { text } = pairingString(chain);
      const { context, page } = await openContext(browser, site.base, chain, { record: { ...baseRecord(VAULT), artifactText: text } });
      const p1 = await page();
      const p2 = await page();
      await p1.waitForSelector('[data-action=approvePairing]');
      await p2.waitForSelector('[data-action=approvePairing]');
      await p1.locator('[data-action=approvePairing]').click();
      await p2.locator('[data-action=approvePairing]').click();
      await p1.waitForSelector('#okBtn');
      await p2.waitForSelector('#okBtn');
      await p1.locator('#okBtn').click();
      await p1.waitForFunction(() => document.querySelector('#toast').textContent.includes('waiting for confirmation'));
      assert.equal(chain.sent.length, 1);
      await p2.locator('#okBtn').click();
      await p2.waitForFunction(() => document.querySelector('#toast').textContent.includes('still unresolved'));
      assert.equal(chain.sent.length, 1, 'the second tab sent nothing');
      await p2.waitForFunction(() => document.querySelector('#main').textContent.includes('waiting to be mined'));
      const ledger = await p2.evaluate(() => JSON.parse(localStorage.getItem('seat-page:1')).pendingApprovals);
      assert.deepEqual(Object.values(ledger)[0], [chain.sent[0].hash], 'the unresolved hash is kept');
      noErrors(p1, p2);
      await context.close();
    });

    await t.test('storage that refuses writes blocks an approval instead of forgetting it', async () => {
      const chain = simulatedChain({ held: true, seatOwner: VAULT });
      const { text } = pairingString(chain);
      const { context, page } = await openContext(browser, site.base, chain, { record: { ...baseRecord(VAULT), artifactText: text }, denyStorage: true });
      const p = await page();
      await p.waitForSelector('[data-action=approvePairing]');
      await p.locator('[data-action=approvePairing]').click();
      // refused before the review dialog: nothing to confirm when the record cannot be kept
      await p.waitForFunction(() => document.querySelector('#toast').textContent.includes('cannot keep a record'));
      assert.equal(await p.locator('#okBtn').count(), 0);
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
      await p.waitForSelector('[data-action=approvePairing]');
      await p.locator('[data-action=approvePairing]').click();
      await p.waitForSelector('#okBtn');
      await p.locator('#okBtn').click();
      await p.waitForFunction(() => document.querySelector('#toast').textContent.includes('waiting for confirmation'));
      assert.equal(chain.sent.length, 1);
      chain.mine(chain.sent[0].hash);
      await p.waitForFunction(() => document.querySelector('#details').textContent.includes('code C0DE1'), null, { timeout: 60_000 });
      await new Promise((r) => setTimeout(r, 3500)); // the code's deadline passes
      await p.waitForSelector('[data-action=registerAgent]', { timeout: 30_000 });
      const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('seat-page:1')).intents);
      assert.equal(Object.values(kept)[0].data, artifact.intent.data, 'the intent was kept apart from the expired string');
      await p.locator('[data-action=registerAgent]').click();
      await p.waitForSelector('#okBtn');
      await p.locator('#okBtn').click();
      await p.waitForFunction(() => document.querySelector('#toast').textContent.includes('waiting for confirmation'));
      assert.equal(chain.sent.length, 2);
      const reg = decodeFunctionData({ abi: SeatVaultAbi, data: chain.sent[1].data });
      assert.equal(reg.functionName, 'registerAgent');
      assert.equal(reg.args[0], artifact.intent.data);
      chain.mine(chain.sent[1].hash);
      await p.waitForFunction(() => document.querySelector('h1').textContent.includes('Your side is done'), null, { timeout: 60_000 });
      assert.ok((await p.locator('#notes').textContent()).includes('Your host confirms'));
      noErrors(p);
      await context.close();
    });
  } finally {
    await site.close();
    await browser.close();
  }
});
