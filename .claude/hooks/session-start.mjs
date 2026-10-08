#!/usr/bin/env node
/**
 * SessionStart primer — injects only per-session STATE (CLAUDE.md already carries the rules):
 * branch, uncommitted file count, whether deps are installed, the board's NOW line.
 * Fails open; target < 50 ms.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 2000 });
  return r.status === 0 ? r.stdout.trim() : '';
}

function boardNow() {
  try {
    const board = readFileSync('.claude/work/BOARD.md', 'utf8');
    const section = board.split(/^## NOW.*$/m)[1] ?? '';
    const line = section.split('\n').find((l) => l.startsWith('- ')) ?? '';
    return line.length > 280 ? line.slice(0, 277) + '…' : line;
  } catch {
    return '';
  }
}

const lines = ['llull session state (rules: CLAUDE.md + .claude/rules/):'];
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch) {
  const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
  lines.push(`- branch: ${branch}${dirty ? ` (${dirty} uncommitted file(s))` : ' (clean)'}`);
}
if (!existsSync('node_modules')) lines.push('- node_modules missing: run `npm install` before `npm run check`.');
const now = boardNow();
if (now) lines.push(`- board NOW: ${now.slice(2)}`);

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }),
);
process.exit(0);
