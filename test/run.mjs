/** Runs every Substrate test suite in sequence. */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter(f => f.startsWith('t_') && f.endsWith('.mjs')).sort();

let failed = 0;
for (const s of suites) {
  console.log(`\n=== ${s} ===`);
  const r = spawnSync(process.execPath, [join(here, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
