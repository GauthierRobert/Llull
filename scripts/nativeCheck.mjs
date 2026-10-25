#!/usr/bin/env node
/**
 * Gate for the Rust workspace `solver/` (docs/decisions/RS1-native-compute.md): cargo fmt --check, clippy -D warnings, test.
 * Skips with a notice when cargo is not installed (CI always has it). The OCCT kernel crates link a shared OpenCascade built by
 * solver/scripts/build-occt.mjs (LLULL_OCCT_DIR or its default prefix), so they run only with LLULL_NATIVE_KERNEL=1 (otherwise the
 * workspace default-members are checked).
 * Locally it also skips when `solver/` is identical to its merge-base with origin/main (no committed, staged, unstaged or untracked
 * change): `cargo test` alone takes ~100 s on an unchanged tree. CI (`CI` set) and LLULL_NATIVE_CHECK=1 always run it.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const solver = path.join(root, 'solver');

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** True only when git proves `solver/` has no change against origin/main's merge-base; any git failure means "changed". */
function solverUnchanged() {
  const base = git(['merge-base', 'HEAD', 'origin/main']);
  if (base.status !== 0) return false;
  const diff = git(['diff', '--quiet', base.stdout.trim(), '--', 'solver']);
  if (diff.status !== 0) return false;
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'solver']);
  return untracked.status === 0 && untracked.stdout.trim() === '';
}

if (!process.env['CI'] && process.env['LLULL_NATIVE_CHECK'] !== '1' && solverUnchanged()) {
  console.warn('native:check skipped: solver/ unchanged against origin/main (LLULL_NATIVE_CHECK=1 forces it).');
  process.exit(0);
}
if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.warn('native:check skipped: cargo not found (install Rust from https://rustup.rs to check solver/).');
  process.exit(0);
}
const scope = process.env['LLULL_NATIVE_KERNEL'] === '1' ? ['--workspace'] : [];
const steps = [
  ['fmt', '--all', '--check'],
  ['clippy', ...scope, '--all-targets', '--quiet', '--', '-D', 'warnings'],
  ['test', ...scope, '--quiet'],
];
for (const args of steps) {
  const run = spawnSync('cargo', args, { cwd: solver, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
