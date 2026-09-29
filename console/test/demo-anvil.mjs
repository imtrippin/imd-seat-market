#!/usr/bin/env node
// Holds a complete offline environment (anvil + fake IMD + console) at one stage of an agreement, for looking at
// the page or taking screenshots. Nothing real is touched.
//   node test/demo-anvil.mjs --stage approved --console-port 18822 --seconds 120
// Stages: created, deposited, offered, approved, paired, active.
import { startAnvilEnv, driveTo, haveArtifacts } from './anvil-env.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const stage = arg('--stage', 'approved');
const consolePort = Number(arg('--console-port', 18822));
const seconds = Number(arg('--seconds', 120));
if (!haveArtifacts) { console.error('no Foundry artifacts: run forge build in contracts/'); process.exit(2); }
const env = await startAnvilEnv({ anvilPort: Number(arg('--anvil-port', 8548)), consolePort });
if (!env) { console.error('anvil did not start'); process.exit(2); }
try {
  const s = await driveTo(env, stage);
  if (stage === 'active') await env.mintReward(s.vault.address, 125n * 10n ** 18n);
  console.log(`ready: stage ${stage}, step ${s.derived.step}, console ${env.base}/ (owner ${env.addr.owner}, host ${env.addr.host})`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
} finally {
  await env.stop();
}
