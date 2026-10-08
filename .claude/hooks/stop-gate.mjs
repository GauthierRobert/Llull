#!/usr/bin/env node
/**
 * Stop hook — cheap "definition of done" gate on the working tree (git status only, no test run):
 * - `packages/*\/src` TS changed but no test file changed  -> ask for a test (or a reason).
 * - a `__snapshots__` file changed                         -> confirm the diff is intended.
 * - `.claude/` or CLAUDE.md changed                        -> claude-lint must pass.
 * Opt-in: LLULL_STOP_VERIFY=1 also runs `vitest related` on the changed package sources.
 * Blocks at most once per distinct finding set per session (fingerprint in os.tmpdir()), never
 * while `stop_hook_active`. Fails open.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintClaude } from './claude-lint.mjs';

async function main() {
  const data = await readStdin();
  if (data.stop_hook_active) return;
  const status = spawnSync('git', ['status', '--porcelain', '-uall'], { encoding: 'utf8', timeout: 3000 });
  if (status.status !== 0) return;
  const changed = status.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''));
  if (changed.length === 0) return;

  const sources = changed.filter((f) => /^packages\/[^/]+\/src\/.*\.tsx?$/.test(f));
  const tests = changed.filter((f) => /^(tests|server\/tests)\//.test(f) || /\.test\.tsx?$/.test(f));
  const snapshots = changed.filter((f) => f.includes('__snapshots__/'));
  const claudeChanged = changed.some((f) => f.startsWith('.claude/') || f === 'CLAUDE.md');

  const findings = [];
  if (sources.length && !tests.length)
    findings.push(
      `Package source changed without a test change (${sources.slice(0, 4).join(', ')}${sources.length > 4 ? ', …' : ''}). ` +
        'Add happy + failure tests, or state why no test is needed. [workflow W1]',
    );
  if (snapshots.length)
    findings.push(
      `Snapshot(s) changed: ${snapshots.join(', ')}. Confirm each diff is intended and say so in your report — ` +
        'agents read tool-schema texts; golden diffs mean behaviour changed. [rules/commands.md]',
    );
  if (claudeChanged) {
    const errors = lintClaude();
    if (errors.length) findings.push(`claude-lint failed:\n  - ${errors.join('\n  - ')}`);
  }
  if (process.env.LLULL_STOP_VERIFY === '1' && sources.length && existsSync('node_modules')) {
    const run = spawnSync('npx', ['vitest', 'related', '--run', ...sources], { encoding: 'utf8', timeout: 180000 });
    if (run.status !== 0)
      findings.push(`vitest related failed:\n${(run.stdout + run.stderr).trim().split('\n').slice(-25).join('\n')}`);
  }
  if (findings.length === 0) return;

  const fingerprintFile = join(tmpdir(), `llull-stop-gate-${String(data.session_id ?? 'default').replace(/\W/g, '')}.txt`);
  const fingerprint = findings.map((f) => f.split('\n')[0]).join('|');
  if (existsSync(fingerprintFile) && readFileSync(fingerprintFile, 'utf8') === fingerprint) return;
  writeFileSync(fingerprintFile, fingerprint);

  process.stdout.write(JSON.stringify({ decision: 'block', reason: 'llull done-gate:\n- ' + findings.join('\n- ') }));
}

async function readStdin() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
main()
  .catch(() => {})
  .finally(() => process.exit(0));
