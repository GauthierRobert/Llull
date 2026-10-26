#!/usr/bin/env node
/**
 * Machine-wide slot lock for heavy runs (full test suites, coverage, server suite, native builds):
 * `node scripts/heavyLock.mjs <label> -- <command…>`. Parallel agents in sibling worktrees otherwise run several at once, and every one
 * of them gets slower (RAM, CPU) than if they ran in turn. Waits for a free slot, runs the command with inherited stdio, frees the slot.
 * Slots live in `~/.cache/llull/heavy-locks/slot-<n>` (one per machine, shared by every checkout) (mkdir is atomic); a slot whose owner process is gone is reclaimed.
 * Env: LLULL_HEAVY_SLOTS (default 1), LLULL_HEAVY_LOCK=0 or CI to bypass. Nested heavy scripts inherit LLULL_HEAVY_HELD and do not re-lock.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const separator = process.argv.indexOf('--');
const label = separator > 2 ? process.argv[2] : 'heavy';
const command = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);
if (command.length === 0) {
  console.error('usage: node scripts/heavyLock.mjs <label> -- <command…>');
  process.exit(2);
}

const bypass = process.env.LLULL_HEAVY_HELD === '1' || process.env.LLULL_HEAVY_LOCK === '0' || Boolean(process.env.CI);
const slots = Math.max(1, Number.parseInt(process.env.LLULL_HEAVY_SLOTS ?? '1', 10) || 1);
const root = join(homedir(), '.cache', 'llull', 'heavy-locks');
const POLL_MS = 2000;
const STALE_MS = 4 * 3600e3;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readOwner(slot) {
  try {
    return JSON.parse(readFileSync(join(slot, 'owner.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function tryAcquire() {
  mkdirSync(root, { recursive: true });
  for (let index = 0; index < slots; index++) {
    const slot = join(root, `slot-${index}`);
    try {
      mkdirSync(slot);
    } catch {
      const owner = readOwner(slot);
      // An owner file is written right after mkdir: a slot without one is only stale once it is old.
      const stale = owner ? !isAlive(owner.pid) || Date.now() - owner.started > STALE_MS : false;
      if (stale) rmSync(slot, { recursive: true, force: true });
      continue;
    }
    writeFileSync(join(slot, 'owner.json'), JSON.stringify({ pid: process.pid, label, cwd: process.cwd(), started: Date.now() }));
    return slot;
  }
  return undefined;
}

function holders() {
  const list = [];
  for (let index = 0; index < slots; index++) {
    const owner = readOwner(join(root, `slot-${index}`));
    if (owner) list.push(`${owner.label} (pid ${owner.pid}, ${owner.cwd}, ${Math.round((Date.now() - owner.started) / 1000)}s)`);
  }
  return list.join('; ') || 'a starting run';
}

async function acquire() {
  const waitStarted = Date.now();
  let lastNotice = 0;
  for (;;) {
    const slot = tryAcquire();
    if (slot) {
      if (lastNotice) console.error(`[heavy-lock] ${label}: got a slot after ${Math.round((Date.now() - waitStarted) / 1000)}s`);
      return slot;
    }
    if (Date.now() - lastNotice > 60e3) {
      console.error(`[heavy-lock] ${label}: waiting for a free slot (held by ${holders()}); LLULL_HEAVY_LOCK=0 bypasses`);
      lastNotice = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const slot = bypass ? undefined : await acquire();
const release = () => {
  if (slot) rmSync(slot, { recursive: true, force: true });
};
// One argument is a shell line (`"npm run a && npm run b"`); several are argv words, quoted when they need it.
const quote = (arg) => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);
const line = command.length === 1 ? command[0] : command.map(quote).join(' ');
const child = spawn(line, { shell: true, stdio: 'inherit', env: { ...process.env, LLULL_HEAVY_HELD: '1' } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('close', (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
