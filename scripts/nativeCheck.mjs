#!/usr/bin/env node
/**
 * Gate for the Rust workspace `solver/` (docs/decisions/RS1-native-compute.md): cargo fmt --check, clippy -D warnings, test.
 * Skips with a notice when cargo is not installed (CI always has it). The OCCT kernel crates link a shared OpenCascade built by
 * solver/scripts/build-occt.mjs (LLULL_OCCT_DIR or its default prefix), so they run only with LLULL_NATIVE_KERNEL=1 (otherwise the
 * workspace default-members are checked).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const solver = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'solver');
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
