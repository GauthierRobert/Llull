/**
 * npm run quality:physics (PHY-00 FR-VNV-12): run the physics packs' unit tests and the FE benchmark tests (server, real Netgen (llull-mesh) +
 * CalculiX when installed) with measurement recording, then judge every
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

// shell: true joins the arguments with spaces. Node refuses to spawn a .cmd with shell: false (EINVAL), so on win32 every argument is quoted; one
// holding a double quote or a percent sign (cmd would expand it) is refused rather than escaped.
const shellQuote = (arg) => {
  if (/["%]/.test(arg)) throw new Error('unsafe argument for the cmd shell: ' + arg);
  return '"' + arg + '"';
};
const run = (command, args, env = {}) =>
  spawnSync(command, process.platform === 'win32' ? args.map(shellQuote) : args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  }).status ?? 1;

const env = { LLULL_PHYSICS_MEASUREMENTS: measurements };
const tests = run('npx', ['vitest', 'run', 'tests/unit/physics', 'tests/unit/cae'], env);
if (tests !== 0) process.exit(tests);
// FE benchmarks through the real Netgen + CalculiX pipeline (skipped inside the suite when the tools are absent).
const feTests = run('npm', ['--prefix', 'server', 'test', '--', 'feaThermal', 'feaThermomech', 'feaConvergence'], env);
if (feTests !== 0) process.exit(feTests);
process.exit(
  run('node', [
    'server/bin/llull.cjs',
    'run_benchmarks',
    `measurements=${measurements}`,
    '--save',
    path.join(cache, 'reports', 'benchmarks.json'),
  ]),
);
