/**
 * Detection and process runner of the OPTIONAL MFront / MTest tools (PHY-02 FR-MATL-23, OQ-MATL-05). llull does NOT bundle MFront (licence
 * review open: GPL-3 with linking exception or CeCILL-A): the user installs TFEL / MFront as a separate program and tells llull where it is.
 *   LLULL_MTEST   path of the `mtest` executable   (default: `mtest` on PATH)
 *   LLULL_MFRONT  path of the `mfront` executable  (default: `mfront` on PATH; needed only to compile an .mfront source)
 * Absent tools are a normal condition: callers get a reason string, never an exception.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { captureStderrTail } from '../pythonExchange';
import { trackChild } from '../childProcesses';

const LOG_TAIL_BYTES = 64 * 1024;
const SECRETS = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY)/i;

export interface MfrontTools {
  /** Absolute path of `mtest`, or null. */
  readonly mtest: string | null;
  /** Absolute path of `mfront`, or null. */
  readonly mfront: string | null;
  /** Why a tool is missing (both reasons joined), or null when both were found. */
  readonly reason: string | null;
}

export interface ProcessResult {
  /** null = killed (timeout) or not started. */
  readonly exitCode: number | null;
  readonly log: string;
  readonly timedOut: boolean;
  /** Set when the executable could not be started (ENOENT, EACCES). */
  readonly startError?: string;
}

export interface ProcessRunner {
  run(executable: string, args: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<ProcessResult>;
}

/** `name` on the PATH of `env` (with PATHEXT on Windows), or null. */
function onPath(name: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean, platform: NodeJS.Platform): string | null {
  const directories = (env['PATH'] ?? env['Path'] ?? '').split(path.delimiter).filter((entry) => entry !== '');
  const extensions = platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').map((ext) => ext.toLowerCase())] : [''];
  for (const directory of directories)
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (exists(candidate)) return path.resolve(candidate);
    }
  return null;
}

function locate(
  tool: 'mtest' | 'mfront',
  variable: string,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean,
  platform: NodeJS.Platform,
): { path: string | null; reason: string | null } {
  const configured = env[variable];
  if (configured !== undefined && configured !== '')
    return exists(configured)
      ? { path: path.resolve(configured), reason: null }
      : { path: null, reason: `${variable}=${configured} does not exist` };
  const found = onPath(tool, env, exists, platform);
  return found !== null
    ? { path: found, reason: null }
    : {
        path: null,
        reason: `${tool} not found: install TFEL / MFront yourself and set ${variable} (llull does not bundle it) or put ${tool} on PATH`,
      };
}

/** Where the optional tools are; never throws. */
export function mfrontTools(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): MfrontTools {
  const mtest = locate('mtest', 'LLULL_MTEST', env, exists, platform);
  const mfront = locate('mfront', 'LLULL_MFRONT', env, exists, platform);
  const reasons = [mtest.reason, mfront.reason].filter((reason): reason is string => reason !== null);
  return { mtest: mtest.path, mfront: mfront.path, reason: reasons.length === 0 ? null : reasons.join('; ') };
}

/** The environment a tool may see: the server's own minus anything that looks like a credential. */
export const toolEnvironment = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !SECRETS.test(key)));

/** The real runner: one tracked child, hard timeout, last 64 KB of stdout + stderr kept. */
export const spawnRunner: ProcessRunner = {
  run: (executable, args, cwd, timeoutMs, env) =>
    new Promise((resolve) => {
      const child = trackChild(spawn(executable, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
      const stdout = captureStderrTail(child.stdout, LOG_TAIL_BYTES);
      const stderr = captureStderrTail(child.stderr, LOG_TAIL_BYTES);
      let timedOut = false;
      let settled = false;
      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (error) => finish({ exitCode: null, log: '', timedOut: false, startError: error.message }));
      child.on('close', (code) => finish({ exitCode: code, log: `${stdout()}${stderr()}`.slice(-LOG_TAIL_BYTES), timedOut }));
    }),
};
