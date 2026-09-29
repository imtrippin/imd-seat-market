// Optional browser rehearsal: real vault bytecode, local Anvil, fake IMD and public fixture accounts only.
// Set REVIEW_NODE_PACKAGES if Playwright is installed outside this package. Screenshots are opt-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAnvilEnv, driveTo, waitFor } from './anvil-env.mjs';
import { startConsole } from '../server.mjs';

const require = process.env.REVIEW_NODE_PACKAGES ? createRequire(join(process.env.REVIEW_NODE_PACKAGES, 'package.json')) : createRequire(import.meta.url);
const { chromium } = require('playwright');
const output = process.env.REVIEW_OUTPUT_DIR;
if (output) mkdirSync(output, { recursive: true });
const results = [];
for (const [index, scenario] of ['normal', 'owner-reload', 'host-browser-closed'].entries()) {
  test(`simple connection: ${scenario}`, { timeout: 150_000 }, async () => {
    const env = await startAnvilEnv({ anvilPort: 8560 + index });
    assert.ok(env, 'Anvil must be available');
    let browser, ownerConsole;
    try {
      const initial = await driveTo(env, 'deposited');
      ownerConsole = await startConsole({ config: env.config });
      await ownerConsole.session.selectVault(initial.vault.address);
      const ownerBase = `http://127.0.0.1:${ownerConsole.port}`;
      const ownerApi = async (path, body) => {
        const r = await fetch(ownerBase + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
      };
      browser = await chromium.launch({ headless: true, channel: 'chrome' });
      const errors = [], calls = { owner: [], host: [] };
      let rejectApproval = index === 0, ownerTransactions = 0;
      async function pageFor(who, url, width) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.exposeFunction('fixtureWallet', async ({ method, params }) => {
          calls[who].push(method);
          if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [env.addr[who]];
          if (method === 'eth_chainId') return '0x7a69';
          if (method === 'personal_sign') return env.wallets[who].account.signMessage({ message: { raw: params[0] } });
          if (method === 'eth_sendTransaction') {
            assert.equal(who, 'owner');
            const action = ownerTransactions === 0 ? 'approvePairing' : 'registerAgent';
            const expected = await ownerApi('/api/tx/build', { action });
            assert.equal(params[0].from.toLowerCase(), env.addr.owner.toLowerCase());
            assert.equal(params[0].to.toLowerCase(), initial.vault.address.toLowerCase());
            assert.equal(params[0].to, expected.to);
            assert.equal(params[0].data, expected.data);
            if (rejectApproval) { rejectApproval = false; throw new Error('Fixture wallet: approval rejected'); }
            ownerTransactions++;
            return env.wallets.owner.sendTransaction({ to: expected.to, data: expected.data });
          }
          throw new Error(`Fixture refuses wallet method ${method}`);
        });
        await page.addInitScript(() => { window.ethereum = { request: (p) => window.fixtureWallet(p), on: () => {} }; });
        await page.goto(url);
        await page.locator('#walletBox').getByRole('button', { name: 'Connect wallet', exact: true }).click();
        await page.locator('.role-tag').filter({ hasText: new RegExp(`^${who}$`) }).waitFor();
        return page;
      }
      const ownerPage = await pageFor('owner', ownerBase, index === 0 ? 1440 : 390);
      const hostPage = await pageFor('host', env.base, 1440);
      assert.equal(await ownerPage.locator('#consoleDetails').getAttribute('open'), null);
      if (index === 0) {
        await hostPage.locator('#consoleDetails > summary').click();
        assert.equal(await hostPage.locator('[data-action="pairing-start"]').isEnabled(), true, 'manual fallback remains available');
        await hostPage.locator('#consoleDetails > summary').click();
      }
      await hostPage.getByRole('button', { name: 'Accept connections', exact: true }).click();
      await hostPage.getByRole('button', { name: 'Sign in wallet', exact: true }).click();
      await hostPage.getByRole('heading', { name: 'Ready for your NFT', exact: true }).waitFor();
      await new Promise((resolve) => setTimeout(resolve, 3500));
      assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/start').length, 0);
      if (output && index === 0) await hostPage.screenshot({ path: join(output, 'host-ready.png'), fullPage: true });
      if (scenario === 'host-browser-closed') await hostPage.close();
      await ownerPage.getByRole('button', { name: 'Connect my NFT', exact: true }).click();
      await ownerPage.getByRole('button', { name: 'Sign in wallet', exact: true }).click();
      const approve = () => ownerPage.locator('#setupRoom [data-action="approvePairing"]');
      await approve().waitFor();
      assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/start').length, 1);
      assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/complete').length, 0);
      if (scenario === 'owner-reload') {
        await ownerPage.reload();
        await ownerPage.locator('#walletBox').getByRole('button', { name: 'Connect wallet', exact: true }).click();
        await approve().waitFor();
      }
      if (output) await ownerPage.screenshot({ path: join(output, `${scenario}-approval.png`), fullPage: true });
      await approve().click();
      await ownerPage.getByRole('button', { name: 'Continue in wallet', exact: true }).click();
      if (index === 0) {
        await ownerPage.locator('#toast').filter({ hasText: 'approval rejected' }).waitFor();
        assert.equal(ownerTransactions, 0);
        assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/complete').length, 0);
        await approve().click();
        await ownerPage.getByRole('button', { name: 'Continue in wallet', exact: true }).click();
      }
      await ownerPage.getByRole('heading', { name: 'Worker connected', exact: true }).waitFor();
      assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/complete').length, 1);
      assert.equal(env.console.session.setup.armedUntil, 0, 'host authorization consumed after one connection');
      await ownerPage.getByRole('button', { name: 'Finish setup', exact: true }).click();
      await ownerPage.getByRole('button', { name: 'Continue in wallet', exact: true }).click();
      await ownerPage.getByRole('heading', { name: 'NFT connected', exact: true }).waitFor();
      await waitFor(async () => (await ownerApi('/api/state')).derived.step === 'active', 'active agreement');
      assert.equal(ownerTransactions, 2, 'only the approved pairing and registration calls were sent');
      assert.equal(calls.host.filter((m) => m === 'personal_sign').length, 1);
      assert.equal(calls.owner.filter((m) => m === 'personal_sign').length, 1);
      assert.equal(env.imd.state.calls.filter((c) => c.path === '/pair/start').length, 1);
      assert.deepEqual(errors, []);
      assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (output) await ownerPage.screenshot({ path: join(output, `${scenario}-connected.png`), fullPage: true });
      results.push({ scenario, starts: 1, completions: 1, ownerTransactions, pageErrors: errors.length, overflow: false });
      console.log(JSON.stringify(results.at(-1)));
    } finally {
      if (browser) await browser.close();
      if (ownerConsole) await ownerConsole.close();
      await env.stop();
      if (output) writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
    }
  });
}
