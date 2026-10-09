/**
 * Drainage network topology: plan length, slope, reachability and upstream-to-downstream order.
 * @layer domain-aec/civil
 * @pure
 */

import type { CivilModel, ManholeObject, PipeObject } from '@core/model/civil';
import { civilObjectsOf, civilObject } from './model';

/** Plan distance between a pipe's two structures in document units; null when an end is missing. */
export function pipePlanLength(civil: CivilModel, pipe: PipeObject): number | null {
  const from = civilObject(civil, pipe.fromId, 'manhole');
  const to = civilObject(civil, pipe.toId, 'manhole');
  if (!from || !to) return null;
  return Math.hypot(to.position[0] - from.position[0], to.position[1] - from.position[1]);
}

/** Slope (drop per plan length, dimensionless); negative when adverse. */
export function pipeSlope(civil: CivilModel, pipe: PipeObject): number {
  const length = pipePlanLength(civil, pipe);
  return length !== null && length > 0 ? (pipe.invertFrom - pipe.invertTo) / length : 0;
}

/** True when a path of pipes leads from `startId` to `targetId`. */
export function flowsTo(civil: CivilModel, startId: string, targetId: string): boolean {
  const pipes = civilObjectsOf(civil, 'pipe');
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop() ?? '';
    if (current === targetId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const pipe of pipes) if (pipe.fromId === current) stack.push(pipe.toId);
  }
  return false;
}

/** Manholes ordered so every pipe's upstream manhole precedes its downstream one. */
export function manholesUpstreamFirst(civil: CivilModel): ManholeObject[] {
  const manholes = civilObjectsOf(civil, 'manhole');
  const pipes = civilObjectsOf(civil, 'pipe').filter(
    (pipe) => civil.objects[pipe.fromId] && civil.objects[pipe.toId],
  );
  const waiting = new Map(manholes.map((m) => [m.id, pipes.filter((p) => p.toId === m.id).length]));
  const ordered: ManholeObject[] = [];
  const queue = manholes.filter((m) => waiting.get(m.id) === 0);
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    ordered.push(next);
    for (const pipe of pipes) {
      if (pipe.fromId !== next.id) continue;
      const left = (waiting.get(pipe.toId) ?? 0) - 1;
      waiting.set(pipe.toId, left);
      const target = civilObject(civil, pipe.toId, 'manhole');
      if (left === 0 && target) queue.push(target);
    }
  }
  return ordered;
}
