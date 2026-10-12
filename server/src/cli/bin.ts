/**
 * @layer server
 * Process entry of the `llull` CLI (launched by `server/bin/llull.cjs`). A local run with
 * `--timeout` is supervised: the CLI re-runs itself as a child and kills it shortly after the
 * deadline, because a single slow step (an OCC boolean) blocks the child's event loop and could
 * never stop itself. Everything else loads `cliProcess.ts` directly.
 */

import { spawn } from 'node:child_process';
import { cliTarget, parseArgv, stringFlag } from './argv';

/** Set in the supervised child so it runs the CLI instead of supervising again. */
const CHILD_ENV = 'LLULL_CLI_CHILD';

/** The child enforces the deadline between steps itself; the kill comes this much later. */
const KILL_GRACE_SECONDS = 5;

function graceSeconds(env: NodeJS.ProcessEnv): number {
  const override = Number(env['LLULL_CLI_KILL_GRACE_SECONDS']);
  return env['LLULL_CLI_KILL_GRACE_SECONDS'] !== undefined && override >= 0
    ? override
    : KILL_GRACE_SECONDS;
}

/** Seconds of a `--timeout` that needs supervising (a local run, not yet supervised), else undefined. */
function supervisedTimeout(argv: readonly string[], env: NodeJS.ProcessEnv): number | undefined {
  if (env[CHILD_ENV] !== undefined) return undefined;
  const args = parseArgv(argv);
  if (cliTarget(args, env).server !== undefined) return undefined;
  const seconds = Number(stringFlag(args, 'timeout'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function supervise(seconds: number): void {
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, [CHILD_ENV]: '1' },
  });
  let killed = false;
  const timer = setTimeout(
    () => {
      killed = true;
      child.kill('SIGKILL');
    },
    (seconds + graceSeconds(process.env)) * 1000,
  );
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (killed)
      process.stderr.write(
        `llull: timed out after ${seconds}s (--timeout); the run was killed, nothing was saved.\n`,
      );
    process.exit(killed ? 1 : (code ?? 1));
  });
}

const seconds = supervisedTimeout(process.argv.slice(2), process.env);
if (seconds !== undefined) supervise(seconds);
else void import('./cliProcess');
