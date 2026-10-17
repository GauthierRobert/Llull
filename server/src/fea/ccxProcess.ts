/**
 * CalculiX process runner: `ccx -i job` in a job directory, tracked (shutdown kills it), hard timeout, last 64 KB of the log kept.
 * Environment: LLULL_CCX  executable (default "ccx"); OMP_NUM_THREADS (default 1: deterministic) is passed through.
 */

import { spawn } from 'node:child_process';
import { bridgeEnvironment, captureStderrTail } from '../pythonExchange';
import { trackChild } from '../childProcesses';

const LOG_TAIL_BYTES = 64 * 1024;

interface SolverRun {
  /** null = killed (timeout) or not started. */
  readonly exitCode: number | null;
  readonly log: string;
  readonly timedOut: boolean;
  /** Set when the executable could not be started (ENOENT, EACCES). */
  readonly startError?: string;
}

export interface CcxRunner {
  run(jobDirectory: string, jobName: string, timeoutMs: number): Promise<SolverRun>;
  /** "2.21" from `ccx -v`, or "unknown". */
  version(): Promise<string>;
}

function ccxExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_CCX'];
  return configured !== undefined && configured !== '' ? configured : 'ccx';
}

function ccxEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...bridgeEnvironment(env), OMP_NUM_THREADS: env['OMP_NUM_THREADS'] ?? '1' };
}

function execute(executable: string, args: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<SolverRun> {
  return new Promise((resolve) => {
    const child = trackChild(spawn(executable, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    const stdout = captureStderrTail(child.stdout, LOG_TAIL_BYTES);
    const stderr = captureStderrTail(child.stderr, LOG_TAIL_BYTES);
    let timedOut = false;
    let settled = false;
    const finish = (run: SolverRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => finish({ exitCode: null, log: '', timedOut: false, startError: error.message }));
    child.on('close', (code) => finish({ exitCode: code, log: `${stdout()}${stderr()}`.slice(-LOG_TAIL_BYTES), timedOut }));
  });
}

export function createCcxRunner(env: NodeJS.ProcessEnv = process.env): CcxRunner {
  const executable = ccxExecutable(env);
  let version: string | null = null;
  return {
    run: (jobDirectory, jobName, timeoutMs) => execute(executable, ['-i', jobName], jobDirectory, timeoutMs, ccxEnvironment(env)),
    async version() {
      if (version !== null) return version;
      const probe = await execute(executable, ['-v'], process.cwd(), 10_000, ccxEnvironment(env));
      version = /Version\s+([0-9][0-9.]*)/i.exec(probe.log)?.[1] ?? 'unknown';
      return version;
    },
  };
}
