/**
 * The supervisor of a local run with `--timeout` (see `bin.ts`): the CLI re-runs itself as a child and ends the whole process tree shortly after the
 * deadline, because a single slow synchronous step (an OCC boolean) blocks the child's event loop and could never stop itself. A native mesh job the
 * child awaits is stopped by the child itself at the deadline (`deadline.ts`), with a clean refusal.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree } from '../processRunner';
import { cliTarget, parseArgv, stringFlag } from './argv';
import { DEADLINE_ENV } from './deadline';

/** Set in the supervised child so it runs the CLI instead of supervising again. */
export const CHILD_ENV = 'LLULL_CLI_CHILD';

/** The child enforces the deadline between steps itself; the kill comes this much later. */
const KILL_GRACE_SECONDS = 5;

function graceSeconds(env: NodeJS.ProcessEnv): number {
  const override = Number(env['LLULL_CLI_KILL_GRACE_SECONDS']);
  return env['LLULL_CLI_KILL_GRACE_SECONDS'] !== undefined && override >= 0 ? override : KILL_GRACE_SECONDS;
}

/** Seconds of a `--timeout` that needs supervising (a local run, not yet supervised), else undefined. */
export function supervisedTimeout(argv: readonly string[], env: NodeJS.ProcessEnv): number | undefined {
  if (env[CHILD_ENV] !== undefined) return undefined;
  const args = parseArgv(argv);
  if (cliTarget(args, env).server !== undefined) return undefined;
  const seconds = Number(stringFlag(args, 'timeout'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export interface SupervisorHooks {
  /** Starts the child with `env` (the deadline in it). */
  readonly spawnChild?: (env: NodeJS.ProcessEnv) => ChildProcess;
  /** Ends `child` and everything it started (default: `killProcessTree`: taskkill /T by PID on Windows, the process group elsewhere). */
  readonly killTree?: (child: ChildProcess) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: (text: string) => void;
}

/** Run the CLI as a child; past `seconds` plus the grace the child's whole tree is killed (its `llull-compute` included), exit code 1. */
export function supervise(seconds: number, hooks: SupervisorHooks = {}): void {
  const env = hooks.env ?? process.env;
  // one clock for both: the child arms its own deadline from this instant, not from the end of its boot
  const childEnv = { ...process.env, [CHILD_ENV]: '1', [DEADLINE_ENV]: String(Date.now() + seconds * 1000) };
  const child = (hooks.spawnChild ?? ((env): ChildProcess => spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env })))(
    childEnv,
  );
  const killTree = hooks.killTree ?? ((target: ChildProcess): void => killProcessTree(target));
  const stderr = hooks.stderr ?? ((text: string): void => void process.stderr.write(text));
  let killed = false;
  const timer = setTimeout(
    () => {
      killed = true;
      killTree(child);
    },
    (seconds + graceSeconds(env)) * 1000,
  );
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (killed) stderr(`llull: timed out after ${seconds}s (--timeout); the run was killed, nothing was saved.\n`);
    // Nothing else holds the loop: it drains and exits (an immediate process.exit can abort on Windows — cliProcess.ts).
    process.exitCode = killed ? 1 : (code ?? 1);
  });
}
