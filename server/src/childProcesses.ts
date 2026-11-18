/** Registry of live child processes (Python bridge, DWG converters) so shutdown can SIGKILL stragglers. */
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Kill the process tree rooted at `pid` (never by image name): `taskkill /T /F /PID` on Windows (the parent links find detached descendants too), the
 * process group elsewhere. `fallback` runs when the tree kill cannot be done (no such group, taskkill missing).
 */
export function killPidTree(pid: number, fallback: () => void, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    killer.on('error', fallback);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}

/** Kill the process tree rooted at `child`. */
export function killProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  if (child.pid === undefined) return;
  killPidTree(child.pid, () => void child.kill('SIGKILL'), platform);
}

const liveChildren = new Set<ChildProcess>();

/** Remember `child` until it exits; returns it for chaining. */
export function trackChild<T extends ChildProcess>(child: T): T {
  liveChildren.add(child);
  child.once('close', () => void liveChildren.delete(child));
  child.once('error', () => void liveChildren.delete(child));
  return child;
}

/** Kill every tracked child and its descendants (shutdown path); returns how many were signalled. */
export function killAllChildren(): number {
  const children = [...liveChildren];
  liveChildren.clear();
  for (const child of children) killProcessTree(child);
  return children.length;
}

export function liveChildCount(): number {
  return liveChildren.size;
}
