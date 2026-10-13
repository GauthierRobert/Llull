/**
 * Stage the local backend for packaging into build/server: the server bundle (server/dist, incl.
 * the CLI at dist/cli.js), the Python bridge script, and production-only node_modules
 * (`npm ci --omit=dev`, installed for the platform this runs on — build each OS on that OS).
 * Run after `npm run build:server`.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.resolve(desktop, '..', 'server');
const target = path.join(desktop, 'build', 'server');

if (!existsSync(path.join(server, 'dist', 'index.js')) || !existsSync(path.join(server, 'dist', 'cli.js')))
  throw new Error('server/dist is missing: run `npm run build:server` first.');

rmSync(target, { recursive: true, force: true });
mkdirSync(path.join(target, 'python'), { recursive: true });
cpSync(path.join(server, 'dist'), path.join(target, 'dist'), {
  recursive: true,
  filter: (source) => !path.basename(source).startsWith('llull-cli.cjs'),
});
for (const file of ['package.json', 'package-lock.json']) cpSync(path.join(server, file), path.join(target, file));
for (const file of ['llull_bridge.py', 'requirements.txt']) cpSync(path.join(server, 'python', file), path.join(target, 'python', file));

execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: target,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
console.warn(`[stage-server] staged ${target}`);
