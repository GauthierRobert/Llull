// npm run action-matrix -- [--pr] [--shard i/n] [--costs file] [--cost-out file] [--report file] [--bless] [--determinism]
//                           [--design-sample N] [--action-sample N] [--native]
// Runs the action matrix (SC-Q2, docs/ACTION_MATRIX.md): FULL mode by default (every design); --pr runs the sampled slice `npm test` runs.
// --native runs server/tests/actionMatrix.test.ts (native OCCT column, skipped without the llull-kernel binary) instead of the Manifold one.
// Writes the per-design cost file (ms) to node_modules/.cache/action-matrix/cost.json unless --cost-out says otherwise; feed it back with
// --costs to balance the shards.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const cacheDir = path.join(root, 'node_modules', '.cache', 'action-matrix');
mkdirSync(cacheDir, { recursive: true });
const shard = value('shard');
const suffix = shard === undefined ? '' : `-${shard.replace('/', 'of')}`;
const env = {
  ...process.env,
  ACTION_MATRIX_MODE: flag('pr') ? 'pr' : 'full',
  ACTION_MATRIX_COST_OUT: value('cost-out') ?? path.join(cacheDir, `cost${suffix}.json`),
  ACTION_MATRIX_REPORT: value('report') ?? path.join(cacheDir, `report${suffix}.json`),
};
const optional = { shard: 'SHARD', costs: 'COSTS', 'design-sample': 'DESIGN_SAMPLE', 'action-sample': 'ACTION_SAMPLE' };
for (const [name, key] of Object.entries(optional)) if (value(name) !== undefined) env[`ACTION_MATRIX_${key}`] = value(name);
if (flag('bless')) env.ACTION_MATRIX_BLESS = '1';
if (flag('determinism')) env.ACTION_MATRIX_DETERMINISM = '1';

const cwd = flag('native') ? path.join(root, 'server') : root;
const bin = path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(bin)) {
  console.error(`vitest is not installed in ${cwd}; run npm install first`);
  process.exit(2);
}
const target = flag('native') ? ['tests/actionMatrix.test.ts'] : ['tests/action_matrix', '--project', 'node'];
const status = spawnSync(process.execPath, [bin, 'run', ...target], { cwd, env, stdio: 'inherit' }).status ?? 1;
process.stdout.write(`report: ${env.ACTION_MATRIX_REPORT}\ncost file: ${env.ACTION_MATRIX_COST_OUT}\n`);
process.exit(status);
