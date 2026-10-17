/** Rib outline (07 FTR §4.1 `add_rib`): an open polyline path thickened into a closed polygon with mitred joints. */

import type { Vec2 } from '../model/types';
import { selfIntersects } from '../lib/polygon';

/** Smallest 1 + cos(turn angle) accepted at a joint: a sharper turn would need a mitre longer than ~4.5 half-thicknesses. */
const MIN_JOINT = 0.1;

const unit = (from: Vec2, to: Vec2): Vec2 | null => {
  const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return span > 1e-9 ? [(to[0] - from[0]) / span, (to[1] - from[1]) / span] : null;
};

/** Offset of the polyline by `side` (left of the walking direction when positive), mitred at interior vertices; null on a degenerate segment. */
function offsetLine(path: readonly Vec2[], side: number): Vec2[] | null {
  const normals: Vec2[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const direction = unit(path[i] as Vec2, path[i + 1] as Vec2);
    if (direction === null) return null;
    normals.push([-direction[1], direction[0]]);
  }
  return path.map((point, i): Vec2 => {
    const before = normals[i - 1] ?? (normals[i] as Vec2);
    const after = normals[i] ?? before;
    const joint = 1 + before[0] * after[0] + before[1] * after[1];
    return joint < MIN_JOINT
      ? [Number.NaN, Number.NaN]
      : [point[0] + (side * (before[0] + after[0])) / joint, point[1] + (side * (before[1] + after[1])) / joint];
  });
}

/**
 * Counter-clockwise closed polygon of `path` thickened by `thickness`: centred on the path when `symmetric`, else on its left. It is counter-clockwise
 * because the offset on the walking side's right is walked forward and the one on its left backward.
 * @failure fewer than 2 points, a zero-length segment, a joint sharper than ~154 degrees, or a self-crossing result -> reason string
 */
export function thickenedPath(path: readonly Vec2[], thickness: number, symmetric: boolean): Vec2[] | string {
  if (path.length < 2) return 'the rib path needs at least 2 points';
  const lower = offsetLine(path, symmetric ? -thickness / 2 : 0);
  const upper = offsetLine(path, symmetric ? thickness / 2 : thickness);
  if (lower === null || upper === null) return 'the rib path has a zero-length segment';
  const polygon = [...lower, ...upper.reverse()];
  if (polygon.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)))
    return 'the rib path turns too sharply at a joint (> ~154 degrees)';
  return selfIntersects(polygon) ? 'the thickened rib path crosses itself' : polygon;
}
