#!/usr/bin/env node
/**
 * Persistent lane worktrees: `npm run lane -- <n> <branch> [--base origin/main]` prepares `<repo parent>/llull-lane<n>` on a fresh
 * `<branch>` from `<base>` and prints its path. The directory is reused task after task, so its ignored state stays warm: node_modules,
 * the vitest module cache (keyed by absolute path, so a new worktree path always starts cold: ~20 s per test file instead of ~5 s),
 * tsc incremental build info and `solver/target`. Dependencies are reinstalled only when a lockfile changed.
 * Refuses to switch a lane that has uncommitted changes or commits on no remote branch (`--force` overrides the latter only).
 */
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const positional = [];
let base = 'origin/main';
let force = false;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--force') force = true;
  else if (arg === '--base') base = process.argv[++index] ?? base;
  else positional.push(arg);
}
const [lane, branch] = positional;
if (!/^[1-9]\d?$/.test(lane ?? '') || !branch) {
  console.error('usage: npm run lane -- <n 1-99> <branch> [--base origin/main] [--force]');
  process.exit(2);
}

const git = (cwd, ...gitArgs) => execFileSync('git', gitArgs, { cwd, encoding: 'utf8' }).trim();
const npm = (cwd, ...npmArgs) => execSync(`npm ${npmArgs.join(' ')}`, { cwd, stdio: 'inherit' });

const commonDir = resolve(git(process.cwd(), 'rev-parse', '--git-common-dir'));
const mainRoot = dirname(commonDir);
const path = join(dirname(mainRoot), `llull-lane${lane}`);

git(mainRoot, 'fetch', '--quiet', 'origin');
if (!existsSync(path)) {
  git(mainRoot, 'worktree', 'add', '-B', branch, path, base);
} else {
  if (resolve(git(path, 'rev-parse', '--git-common-dir')) !== commonDir) {
    console.error(`${path} exists but is not a worktree of ${mainRoot}`);
    process.exit(1);
  }
  const dirty = git(path, 'status', '--porcelain');
  if (dirty) {
    console.error(`lane ${lane} has uncommitted changes, refusing to switch it:\n${dirty}`);
    process.exit(1);
  }
  const unpublished = git(path, 'log', '--oneline', 'HEAD', '--not', '--remotes');
  if (unpublished && !force) {
    console.error(`lane ${lane} holds commits on no remote branch (push or merge them, or pass --force):\n${unpublished}`);
    process.exit(1);
  }
  git(path, 'switch', '--quiet', '-C', branch, base);
}

const lockfiles = ['package-lock.json', 'server/package-lock.json'];
const stamp = createHash('sha1');
for (const file of lockfiles) stamp.update(existsSync(join(path, file)) ? readFileSync(join(path, file)) : '');
const digest = stamp.digest('hex');
const stampFile = join(path, 'node_modules', '.llull-lane-deps');
const installed = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : '';
if (installed !== digest) {
  npm(path, 'ci', '--no-audit', '--no-fund', '--loglevel=error');
  npm(path, '--prefix', 'server', 'ci', '--no-audit', '--no-fund', '--loglevel=error');
  writeFileSync(stampFile, digest);
}
process.stdout.write(`lane ${lane}: ${path} on ${branch} from ${base}${installed === digest ? '' : ' (dependencies installed)'}\n`);
