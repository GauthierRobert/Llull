/**
 * @layer ui/viewport/3d
 * @pure
 *
 * What a finished gizmo drag turns into: the command + params for the transform the user made, or
 * null when the drag changed nothing (including a translate that snapped back to where it began).
 * The gizmo never edits the entity; the caller dispatches the returned command.
 */

import type { GizmoMode } from '@ui/store';

export type Xyz = { readonly x: number; readonly y: number; readonly z: number };

/** Component-wise `next - prev`: a translation delta (Vector3) or rotation delta (Euler, radians). */
export function computeDelta(prev: Xyz, next: Xyz): [number, number, number] {
  return [next.x - prev.x, next.y - prev.y, next.z - prev.z];
}

/** Single uniform scale factor of a scale vector: the arithmetic mean of its three axes. */
export function computeScaleFactor(scale: Xyz): number {
  return (scale.x + scale.y + scale.z) / 3;
}

/** Deltas below this length are drags that did not move anything. */
const MIN_DELTA = 1e-6;

const isNegligible = (delta: readonly [number, number, number]): boolean =>
  Math.hypot(delta[0], delta[1], delta[2]) < MIN_DELTA;

export interface GizmoTransform {
  readonly position: Xyz;
  readonly rotation: Xyz;
  readonly scale: Xyz;
}

export type GizmoCommit =
  | {
      readonly name: 'move_entity';
      readonly params: { id: string; delta: [number, number, number] };
    }
  | {
      readonly name: 'rotate_entity';
      readonly params: { id: string; delta: [number, number, number] };
    }
  | { readonly name: 'scale_entity'; readonly params: { id: string; factor: number } };

/** @param start transform at drag start; @param end transform at drag end (after any snapping). */
export function gizmoDragCommit(
  mode: GizmoMode,
  id: string,
  start: GizmoTransform,
  end: GizmoTransform,
): GizmoCommit | null {
  if (mode === 'translate') {
    const delta = computeDelta(start.position, end.position);
    return isNegligible(delta) ? null : { name: 'move_entity', params: { id, delta } };
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
