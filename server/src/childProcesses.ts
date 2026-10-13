/** Registry of live child processes (Python bridge, DWG converters) so shutdown can SIGKILL stragglers. */
import type { ChildProcess } from 'node:child_process';

const liveChildren = new Set<ChildProcess>();

/** Remember `child` until it exits; returns it for chaining. */
export function trackChild<T extends ChildProcess>(child: T): T {
  liveChildren.add(child);
  child.once('close', () => void liveChildren.delete(child));
  child.once('error', () => void liveChildren.delete(child));
  return child;
}

/** SIGKILL every tracked child (shutdown path); returns how many were signalled. */
export function killAllChildren(): number {
  const children = [...liveChildren];
  liveChildren.clear();
  for (const child of children) child.kill('SIGKILL');
  return children.length;
}

export function liveChildCount(): number {
  return liveChildren.size;
}
