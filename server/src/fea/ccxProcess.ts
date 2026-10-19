/**
 * CalculiX process runner: `ccx -i job` in a job directory, tracked (shutdown kills it), hard timeout killing the process tree, last 64 KB of
 * the log kept (shared runner: ../processRunner).
 * Environment: LLULL_CCX  executable (default "ccx"); OMP_NUM_THREADS (default 1: deterministic) is passed through.
 */

import { bridgeEnvironment } from '../pythonExchange';
import { runTrackedProcess, type ProcessResult } from '../processRunner';

export interface CcxRunner {
  run(jobDirectory: string, jobName: string, timeoutMs: number): Promise<ProcessResult>;
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

export function createCcxRunner(env: NodeJS.ProcessEnv = process.env): CcxRunner {
  const executable = ccxExecutable(env);
  let version: string | null = null;
  return {
    run: (jobDirectory, jobName, timeoutMs) => runTrackedProcess(executable, ['-i', jobName], jobDirectory, timeoutMs, ccxEnvironment(env)),
    async version() {
      if (version !== null) return version;
      const probe = await runTrackedProcess(executable, ['-v'], process.cwd(), 10_000, ccxEnvironment(env));
      version = /Version\s+([0-9][0-9.]*)/i.exec(probe.log)?.[1] ?? 'unknown';
      return version;
    },
  };
}
