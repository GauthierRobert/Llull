import { readFileSync } from 'node:fs';

/** A killed process nobody has reaped yet (an init that does not reap orphans, as in some containers) still answers signal 0. */
function isZombie(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return false;
  }
}

/** True when `pid` is still a running process (a zombie is dead). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !isZombie(pid);
  } catch {
    return false;
  }
}
