/** Live processes of a given parent, for tests that must show a native job does not outlive its host. Read-only: nothing here kills anything. */

import { execFileSync } from 'node:child_process';

/** Pids of the running processes whose executable is `image` (`llull-compute`, with or without `.exe`) and whose parent is `parentPid`: this test's host, never another lane's job. */
function childPidsOf(image: string, parentPid: number): number[] {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${image}.exe' AND ParentProcessId=${parentPid}" | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return out
      .split(/\s+/)
      .filter((token) => token !== '')
      .map(Number);
  }
  try {
    return execFileSync('pgrep', ['-x', image, '-P', String(parentPid)], { encoding: 'utf8' })
      .split(/\s+/)
      .filter((token) => token !== '')
      .map(Number);
  } catch {
    return [];
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `check` until it returns a value other than undefined, or `timeoutMs` passes (then undefined). */
export async function waitFor<T>(check: () => T | undefined, timeoutMs: number, everyMs = 100): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** The pid of the `image` process started by `parentPid`, once there is one. */
export const jobPidOf = (image: string, parentPid: number): number | undefined => childPidsOf(image, parentPid)[0];
