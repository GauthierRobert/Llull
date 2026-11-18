/**
 * CalculiX process runner: `ccx -i job` in a job directory, tracked (shutdown kills it), hard timeout killing the process tree, last 64 KB of
 * the log kept (shared runner: ../processRunner).
 * Environment: LLULL_CCX  executable (default "ccx"); LLULL_FEA_THREADS  solver threads when the caller names none (default: OMP_NUM_THREADS,
 * else 1: bit-reproducible results).
 */

import { positiveInteger } from '../env';
import { bridgeEnvironment } from '../pythonExchange';
import { runTrackedProcess, type ProcessResult } from '../processRunner';

export interface CcxRunner {
  /** @param threads solver threads of this run; absent = `defaultThreads` */
  run(jobDirectory: string, jobName: string, timeoutMs: number, threads?: number): Promise<ProcessResult>;
  /** Threads of a run that names none (absent = 1). */
  readonly defaultThreads?: number;
  /** "2.21" from `ccx -v`, or "unknown". */
  version(): Promise<string>;
}

function ccxExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_CCX'];
  return configured !== undefined && configured !== '' ? configured : 'ccx';
}

function ccxEnvironment(env: NodeJS.ProcessEnv, threads: number): NodeJS.ProcessEnv {
  return { ...bridgeEnvironment(env), OMP_NUM_THREADS: String(threads) };
}

export function createCcxRunner(env: NodeJS.ProcessEnv = process.env): CcxRunner {
  const executable = ccxExecutable(env);
  const defaultThreads = positiveInteger(env['LLULL_FEA_THREADS'], positiveInteger(env['OMP_NUM_THREADS'], 1));
  let version: string | null = null;
  return {
    defaultThreads,
    run: (jobDirectory, jobName, timeoutMs, threads) =>
      runTrackedProcess(executable, ['-i', jobName], jobDirectory, timeoutMs, ccxEnvironment(env, threads ?? defaultThreads)),
    async version() {
      if (version !== null) return version;
      const probe = await runTrackedProcess(executable, ['-v'], process.cwd(), 10_000, ccxEnvironment(env, 1));
      version = /Version\s+([0-9][0-9.]*)/i.exec(probe.log)?.[1] ?? 'unknown';
      return version;
    },
  };
}
