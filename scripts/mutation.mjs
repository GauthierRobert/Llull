// npm run mutation -- [--folder brep|solids|parametric|history] [--concurrency N] [--file glob] [--full]
// Runs Stryker (stryker.config.mjs) over one commands folder, or all four. --file narrows `mutate` to one glob (sampling);
// --full drops the incremental cache for this run. HTML/JSON reports land in reports/ (gitignored).
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const folder = value('folder');
const env = { ...process.env };
if (folder !== undefined) env.STRYKER_FOLDER = folder;
if (value('concurrency') !== undefined) env.STRYKER_CONCURRENCY = value('concurrency');

// A checkout nested inside another one (.claude/worktrees/*) must not run Stryker: its sandbox also links the ancestor's node_modules,
// whose workspace junctions (node_modules/@llull/* -> packages/*) its cleanup followed on Windows, deleting the outer checkout's packages/.
for (let dir = path.dirname(root); dir !== path.dirname(dir); dir = path.dirname(dir)) {
  if (existsSync(path.join(dir, 'node_modules')) || existsSync(path.join(dir, '.git'))) {
    console.error(`Refusing to run Stryker in a checkout nested inside ${dir} (see docs/MUTATION.md): use a standalone clone or CI.`);
    process.exit(2);
  }
}

const bin = path.join(root, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');
if (!existsSync(bin)) {
  console.error('Stryker is not installed; run npm install first');
  process.exit(2);
}
const extra = [];
const file = value('file');
if (file !== undefined) extra.push('--mutate', file);
if (args.includes('--full')) {
  rmSync(path.join(root, 'reports', `stryker-incremental-${folder ?? 'all'}.json`), { force: true });
}
const result = spawnSync(process.execPath, [bin, 'run', ...extra], { cwd: root, env, stdio: 'inherit' });
process.exit(result.status ?? 1);
