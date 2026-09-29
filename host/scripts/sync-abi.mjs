// Copies the ABI arrays of the vault and the factory from the Foundry artifacts into abi/, so the console runs
// without a Foundry build. Run after `forge build` in contracts/: `npm run abi`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'contracts', 'out', 'SeatVault.sol');
const dest = join(here, '..', 'abi');
mkdirSync(dest, { recursive: true });
for (const name of ['SeatVault', 'SeatVaultFactory']) {
  const artifact = JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
  writeFileSync(join(dest, `${name}.json`), JSON.stringify(artifact.abi, null, 1) + '\n');
  console.log(`${name}: ${artifact.abi.length} ABI entries`);
}
