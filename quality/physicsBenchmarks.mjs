/**
 * npm run quality:physics (PHY-00 FR-VNV-12): run the physics packs' unit tests with measurement recording, then judge every
 * docs/physics/<pack>/validation/expected_results.json case with `llull run_benchmarks`. Exit 1 on any grade-A fail or error.
 * Report: .cache/quality-physics/reports/benchmarks.{json,md} (never committed).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cache = path.join(root, '.cache', 'quality-physics');
const measurements = path.join(cache, 'unit-measurements.jsonl');
mkdirSync(path.join(cache, 'reports'), { recursive: true });
rmSync(measurements, { force: true });

const run = (command, args, env = {}) =>
  spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } }).status ??
  1;

const tests = run('npx', ['vitest', 'run', 'tests/unit/physics'], { LLULL_PHYSICS_MEASUREMENTS: measurements });
if (tests !== 0) process.exit(tests);
process.exit(
  run('node', [
    'server/bin/llull.cjs',
    'run_benchmarks',
    `measurements=${measurements}`,
    '--save',
    path.join(cache, 'reports', 'benchmarks.json'),
  ]),
);
