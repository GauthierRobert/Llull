/**
 * `npm run piping-catalog`: regenerate packages/domain-aec/src/plant/catalog/data/*.ts from the 01 PSC validation pack. The generator
 * (scripts/pipingCatalogGen.ts) is TypeScript, so it runs inside the vitest suite that also guards drift, with LLULL_WRITE_PIPING_CATALOG=1.
 *
 *   node scripts/piping-catalog.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, LLULL_WRITE_PIPING_CATALOG: '1' };
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env });
const vitest = run([
  join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
  'run',
  'tests/unit/plant/piping/catalogDrift.test.ts',
  '--project',
  'node',
]);
if (vitest.status !== 0) process.exit(vitest.status ?? 1);
const prettier = run([
  join(ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs'),
  '--write',
  'packages/domain-aec/src/plant/catalog/data',
]);
if (prettier.status === 0) console.warn('piping catalogue data modules regenerated.');
process.exit(prettier.status ?? 1);
