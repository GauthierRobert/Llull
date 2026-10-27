#!/usr/bin/env node
/**
 * PreToolUse guard (Bash|PowerShell). Blocks shell commands that cost the dev loop or break parallel lanes:
 * - a non-incremental `tsc --noEmit` (~60 s cold every call; the npm typecheck scripts are incremental, ~6 s warm);
 * - `git stash` (other lanes and sessions share checkouts: a stash silently takes their work) — `stash list` / `show` stay allowed;
 * - killing processes by name (`taskkill /IM node.exe`, `Stop-Process -Name node`, `pkill node`): it kills every lane's servers and tests.
 * Fails open: internal error exits 0. Block: JSON permissionDecision deny + stderr + exit 2.
 */
import { readStdin } from './readStdin.mjs';

const RULES = [
  {
    test: (command) =>
      /(^|[;&|(]\s*|\bnpx\s+|\.bin\/)tsc(\.cmd)?\s[^|;&\n]*--noEmit/.test(command) && !/--incremental|\btsc\s[^|;&\n]*-b\b/.test(command),
    reason:
      'non-incremental `tsc --noEmit` (TypeScript 6, ~30-60 s per call). Use `npm run typecheck:app` / `typecheck:tests` / `typecheck` ' +
      'at the root (TypeScript 7, incremental, ~1 s warm) or `npm --prefix server run typecheck`.',
  },
  {
    test: (command) => /\bgit\s+stash\b(?!\s+(list|show)\b)/.test(command),
    reason:
      "`git stash` in a shared checkout takes other lanes' uncommitted work. Commit on your branch or use a lane worktree (`npm run lane`).",
  },
  {
    test: (command) =>
      /\btaskkill\b[^|;&\n]*\/IM\b/i.test(command) ||
      /\bStop-Process\b[^|;&\n]*-Name\b/i.test(command) ||
      /\b(pkill|killall)\b/.test(command),
    reason: "killing processes by name stops every lane's servers and test runs. Kill the PID you started instead.",
  },
];

async function main() {
  const data = await readStdin();
  const command = String(data.tool_input?.command ?? '');
  if (!command) return;
  const hits = RULES.filter((rule) => rule.test(command)).map((rule) => rule.reason);
  if (hits.length === 0) return;
  const reason = `llull guard blocked this command:\n- ${hits.join('\n- ')}\nIf it is genuinely needed, ask the user.`;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  );
  process.stderr.write(reason + '\n');
  process.exit(2);
}
main().catch(() => process.exit(0));
