/**
 * `npm run features` (SC-Q5): regenerate docs/FEATURES.md from the command registry. The generator (scripts/featuresDoc.ts) needs
 * the workspace aliases and the default plugins, so it runs inside the vitest suite that also guards staleness, with
 * LLULL_WRITE_FEATURES=1.
 *
 *   node scripts/features.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/unit/contract/featuresDoc.test.ts', '--project', 'node'],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, LLULL_WRITE_FEATURES: '1' } },
);
if (result.status === 0) console.warn('docs/FEATURES.md regenerated.');
process.exit(result.status ?? 1);
