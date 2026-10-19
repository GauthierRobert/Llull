/**
 * One tracked-child runner shared by the external-solver transports (CalculiX, MFront / MTest): hard timeout that kills the WHOLE process tree
 * (win32: `taskkill /T /F /PID <pid>`, by PID only; elsewhere the child leads its own process group and the group is killed), resolution on
 * 'exit' so the timeout holds even when a grandchild keeps the pipes open, last 64 KB of stdout + stderr kept.
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { captureStderrTail } from './pythonExchange';
import { trackChild } from './childProcesses';

const LOG_TAIL_BYTES = 64 * 1024;
const PIPE_DRAIN_GRACE_MS = 1000;

export interface ProcessResult {
  /** null = killed (timeout) or not started. */
  readonly exitCode: number | null;
  readonly log: string;
  readonly timedOut: boolean;
  /** Set when the executable could not be started (ENOENT, EACCES). */
  readonly startError?: string;
}

interface SpawnPlan {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly detached: boolean;
}

export interface ProcessRunnerHooks {
  readonly spawnProcess: (executable: string, args: readonly string[], options: SpawnPlan) => ChildProcessByStdio<null, Readable, Readable>;
  /** Kills `child` and every descendant. */
  readonly killTree: (child: ChildProcess) => void;
  readonly platform: NodeJS.Platform;
}

/** Kill the process tree rooted at `child` (never by image name). */
function killProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === 'win32') {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

const REAL_HOOKS: ProcessRunnerHooks = {
  spawnProcess: (executable, args, options) =>
    spawn(executable, [...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
  killTree: killProcessTree,
  platform: process.platform,
};

/** Run one tracked child to completion or timeout; never rejects. */
export function runTrackedProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  hooks: ProcessRunnerHooks = REAL_HOOKS,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = trackChild(hooks.spawnProcess(executable, args, { cwd, env, detached: hooks.platform !== 'win32' }));
    const stdout = captureStderrTail(child.stdout, LOG_TAIL_BYTES);
    const stderr = captureStderrTail(child.stderr, LOG_TAIL_BYTES);
    let timedOut = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolve(result);
    };
    const result = (code: number | null): ProcessResult => ({
      exitCode: code,
      log: `${stdout()}${stderr()}`.slice(-LOG_TAIL_BYTES),
      timedOut,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      hooks.killTree(child);
    }, timeoutMs);
    child.on('error', (error) => finish({ exitCode: null, log: '', timedOut: false, startError: error.message }));
    child.on('exit', (code) => {
      if (timedOut) finish(result(code));
      else drain = setTimeout(() => finish(result(code)), PIPE_DRAIN_GRACE_MS);
    });
    child.on('close', (code) => finish(result(code)));
  });
}
