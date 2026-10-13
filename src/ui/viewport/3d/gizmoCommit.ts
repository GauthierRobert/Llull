// Finished gizmo drag → the command + params of the transform, or null when nothing changed (incl. a snap-back).

import type { GizmoMode } from '@ui/store';

export type Xyz = { readonly x: number; readonly y: number; readonly z: number };

/** Translation (Vector3) or rotation (Euler, radians) delta. */
export function computeDelta(prev: Xyz, next: Xyz): [number, number, number] {
  return [next.x - prev.x, next.y - prev.y, next.z - prev.z];
}

/** Mean of the three axes. */
export function computeScaleFactor(scale: Xyz): number {
  return (scale.x + scale.y + scale.z) / 3;
}

/** Deltas below this length are drags that did not move anything. */
const MIN_DELTA = 1e-6;

const isNegligible = (delta: readonly [number, number, number]): boolean => Math.hypot(delta[0], delta[1], delta[2]) < MIN_DELTA;

export interface GizmoTransform {
  readonly position: Xyz;
  readonly rotation: Xyz;
  readonly scale: Xyz;
}

export type GizmoCommit =
  | {
      readonly name: 'move_entities';
      readonly params: { ids: string[]; delta: [number, number, number] };
    }
  | {
      readonly name: 'rotate_entity';
      readonly params: { id: string; delta: [number, number, number] };
    }
  | { readonly name: 'scale_entity'; readonly params: { id: string; factor: number } };

/** Hint for a translate drag that grid snap returned to its start (`rawEnd` moved, nothing committed); else null. */
export function snapBackHint(
  start: Xyz,
  rawEnd: Xyz,
  committed: boolean,
  snapApplied: boolean,
  gridStep: number,
  units: string,
): string | null {
  if (committed || !snapApplied || isNegligible(computeDelta(start, rawEnd))) return null;
  return `Snapped back to grid (Snap on, step ${gridStep} ${units}) — turn Snap off for finer moves.`;
}

/** `end` is after any snapping. */
export function gizmoDragCommit(mode: GizmoMode, id: string, start: GizmoTransform, end: GizmoTransform): GizmoCommit | null {
  if (mode === 'translate') {
    const delta = computeDelta(start.position, end.position);
    return isNegligible(delta) ? null : { name: 'move_entities', params: { ids: [id], delta } };
  }
  if (mode === 'rotate') {
    const delta = computeDelta(start.rotation, end.rotation);
    return isNegligible(delta) ? null : { name: 'rotate_entity', params: { id, delta } };
  }
  const previous = computeScaleFactor(start.scale);
  const next = computeScaleFactor(end.scale);
  const factor = previous > 0 ? next / previous : next;
  if (Math.abs(factor - 1) < MIN_DELTA || factor <= 0) return null;
  return { name: 'scale_entity', params: { id, factor } };
}
