// Builds dist/ from src/ with the chain constants of config.json baked in. `--check` fails when dist/ is stale.
import { build } from 'esbuild';
import { readFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../host/lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = parseConfig(JSON.parse(readFileSync(join(here, 'config.json'), 'utf8')), { needRpc: false });
const check = process.argv.includes('--check');
const outdir = join(here, check ? '.check' : 'dist');
mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: [join(here, 'src', 'app.js')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  nodePaths: [join(here, 'node_modules')], // bare imports in ../host/lib resolve against the page's own pinned packages
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  define: { __CONFIG__: JSON.stringify(config) },
  outfile: join(outdir, 'app.js'),
  logLevel: 'error',
});
for (const f of ['index.html', 'styles.css']) copyFileSync(join(here, 'src', f), join(outdir, f));
if (check) {
  let stale = false;
  for (const f of ['app.js', 'index.html', 'styles.css']) {
    const a = existsSync(join(here, 'dist', f)) ? readFileSync(join(here, 'dist', f), 'utf8') : '';
    if (a !== readFileSync(join(outdir, f), 'utf8')) { stale = true; console.error(`dist/${f} is stale: run npm run build`); }
  }
  process.exit(stale ? 1 : 0);
}
const size = readFileSync(join(outdir, 'app.js')).length;
console.log(`built dist/app.js (${Math.round(size / 1024)} KB) for chain ${config.chainId}, factory ${config.factory}`);
