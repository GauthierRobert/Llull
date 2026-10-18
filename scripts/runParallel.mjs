#!/usr/bin/env node
/**
 * Run npm scripts concurrently (the static gates are single-threaded): `node scripts/runParallel.mjs typecheck lint …`.
 * Each script's output is printed as one block when it ends; exits non-zero if any script failed.
 */
import { spawn } from 'node:child_process';

const scripts = process.argv.slice(2);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(script) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(npm, ['run', '--silent', script], { shell: process.platform === 'win32' });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(`\n── ${script} ${code === 0 ? 'ok' : `FAILED (exit ${code})`} in ${seconds}s\n${output}`);
      resolve(code === 0);
    });
  });
}

const results = await Promise.all(scripts.map(run));
process.exit(results.every(Boolean) ? 0 : 1);
