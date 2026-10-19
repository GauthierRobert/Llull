/**
 * Detection and process runner of the OPTIONAL MFront / MTest tools (PHY-02 FR-MATL-23, OQ-MATL-05). llull does NOT bundle MFront (licence
 * review open: GPL-3 with linking exception or CeCILL-A): the user installs TFEL / MFront as a separate program and tells llull where it is.
 *   LLULL_MTEST   path of the `mtest` executable   (default: `mtest` on PATH)
 *   LLULL_MFRONT  path of the `mfront` executable  (default: `mfront` on PATH; needed only to compile an .mfront source)
 * Absent tools are a normal condition: callers get a reason string, never an exception.
 * Windows: only .exe / .com programs are supported (Node cannot spawn .bat / .cmd wrappers without a shell).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { runTrackedProcess, type ProcessResult } from '../processRunner';

const SECRETS = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY)/i;

export interface MfrontTools {
  /** Absolute path of `mtest`, or null. */
  readonly mtest: string | null;
  /** Absolute path of `mfront`, or null. */
  readonly mfront: string | null;
  /** Why a tool is missing (both reasons joined), or null when both were found. */
  readonly reason: string | null;
}

export interface ProcessRunner {
  run(executable: string, args: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<ProcessResult>;
}

const isWrapper = (file: string): boolean => /\.(bat|cmd)$/i.test(file);

/** Node cannot spawn .bat / .cmd wrappers without a shell: on Windows only .exe / .com are accepted from PATHEXT. */
const isSpawnable = (extension: string): boolean => extension === '.exe' || extension === '.com';

/** `name` on the PATH of `env` (with the spawnable PATHEXT entries on Windows), or null. */
function onPath(name: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean, platform: NodeJS.Platform): string | null {
  const directories = (env['PATH'] ?? env['Path'] ?? '').split(path.delimiter).filter((entry) => entry !== '');
  const pathExt = (env['PATHEXT'] ?? '.EXE;.COM').split(';').map((ext) => ext.toLowerCase());
  const extensions = platform === 'win32' ? ['', ...pathExt.filter(isSpawnable)] : [''];
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
  if (configured !== undefined && configured !== '') {
    if (platform === 'win32' && isWrapper(configured))
      return { path: null, reason: `${variable}=${configured} is a .bat / .cmd wrapper, which is unsupported: point it at the .exe` };
    return exists(configured)
      ? { path: path.resolve(configured), reason: null }
      : { path: null, reason: `${variable}=${configured} does not exist` };
  }
  const found = onPath(tool, env, exists, platform);
  return found !== null
    ? { path: found, reason: null }
    : {
        path: null,
        reason: `${tool} not found: install TFEL / MFront yourself and set ${variable} (llull does not bundle it) or put ${tool} (.exe on Windows; .bat / .cmd wrappers are unsupported) on PATH`,
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

/** The real runner: one tracked child, hard timeout killing its process tree, last 64 KB of stdout + stderr kept. */
export const spawnRunner: ProcessRunner = {
  run: (executable, args, cwd, timeoutMs, env) => runTrackedProcess(executable, args, cwd, timeoutMs, env),
};
