/**
 * Pure 2D geometry helpers for snapping: segment extraction, intersections, and the
 * advanced snap constructions (perpendicular, tangent, extension, nearest).
 */

import { clamp } from '@lib/clamp';
import type { Entity, Vec2 } from '@core/model/types';
import { entityPlanPoint } from '@core/geometry/entityFrame';
import { projectOntoSegment } from '@lib/polygon';
import { wrapAngle } from '@lib/angle';
import type { SnapPoint } from './types';
import { closeLoop, rectangleCorners } from '../../lineGeometry';

/** Line segment as [x1, y1, x2, y2]. */
export type Segment = [number, number, number, number];

/** True when `angle` lies within the counter-clockwise sweep startAngle→endAngle (inclusive, with tolerance). */
export function isAngleOnArc(angle: number, startAngle: number, endAngle: number): boolean {
  const sweep = wrapAngle(endAngle - startAngle);
  const offset = wrapAngle(angle - startAngle);
  const eps = 1e-9;
  return offset <= sweep + eps || offset >= 2 * Math.PI - eps;
}

/** Midpoint of two 2D points. */
export function mid(ax: number, ay: number, bx: number, by: number): [number, number] {
  return [(ax + bx) / 2, (ay + by) / 2];
}

/** Entity-local 2D point -> world XY: rotated about the entity origin by rotation[2], then offset by position. */
export function localToWorld2D(entity: Entity, lx: number, ly: number): [number, number] {
  const [x, y] = entityPlanPoint(entity, [lx, ly]);
  return [x, y];
}

/**
 * Extract line segments as [x1,y1,x2,y2] pairs from a 2D entity in world space
 * (entity rotation about Z and position applied).
 */
export function entityToSegments(entity: Entity): Segment[] {
  const segmentBetween = (a: Vec2, b: Vec2): Segment => [...localToWorld2D(entity, a[0], a[1]), ...localToWorld2D(entity, b[0], b[1])];
  const chain = (points: ReadonlyArray<Vec2>, closed: boolean): Segment[] => {
    const path = closed && points.length >= 2 ? closeLoop(points) : points;
    return path.flatMap((a, index) => {
      const b = path[index + 1];
      return b ? [segmentBetween(a, b)] : [];
    });
  };

  switch (entity.kind) {
    case 'line': {
      return [segmentBetween(entity.start, entity.end)];
    }
    case 'polyline':
      return chain(entity.points, entity.closed);
    case 'rectangle':
      return chain(rectangleCorners(entity.width, entity.height), true);
    default:
      return [];
  }
}

/**
 * Unclamped parameter t of the foot of (px,py) on the line a→b (0 at a, 1 at b).
 * @failure returns null when a and b coincide
 */
function footParameter(px: number, py: number, ax: number, ay: number, bx: number, by: number): number | null {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  return lenSq < 1e-20 ? null : ((px - ax) * dx + (py - ay) * dy) / lenSq;
}

/**
 * Snap perpendicular to a segment from reference point `from`.
 * Returns the foot point only when it lies within the segment extents (0 ≤ t ≤ 1).
 * When `from` is null the snap is skipped (no previous point).
 */
export function snapPerpendicular(from: Vec2 | null, ax: number, ay: number, bx: number, by: number): SnapPoint | null {
  if (from === null) return null;
  const t = footParameter(from[0], from[1], ax, ay, bx, by);
  if (t === null || t < 0 || t > 1) return null; // degenerate segment, or foot outside it
  return { x: ax + t * (bx - ax), y: ay + t * (by - ay), type: 'perpendicular' };
}

/**
 * Compute tangent points from external point (px,py) to a circle at (cx,cy)
 * with radius r. Returns 0, 1, or 2 tangent points.
 *
 * Uses the acos construction: α = acos(r/d) where d = distance from point to center.
 * Tangent points lie on the circle at angles (θ ± α) from center,
 * where θ = atan2(py-cy, px-cx).
 *
 * Correctness proof: T = C + r*(cosφ, sinφ). Requires (T-C)⊥(P-T):
 *   dot = r*d*cos(φ-θ) - r² = 0 → cos(φ-θ) = r/d → φ = θ ± acos(r/d) ✓
 *
 * Returns [] when the point is strictly inside the circle (no real tangent).
 *
 * @invariant Returns [] when px,py is strictly inside the circle.
 */
export function tangentPointsToCircle(px: number, py: number, cx: number, cy: number, r: number): Array<[number, number]> {
  const dx = px - cx;
  const dy = py - cy;
  const d = Math.hypot(dx, dy);
  if (d < r - 1e-10) return []; // inside circle — no tangent
  if (d < 1e-10) return []; // degenerate: point at center
  const theta = Math.atan2(dy, dx);
  const alpha = Math.acos(Math.min(r / d, 1)); // clamp for numerical safety at d==r
  return [
    [cx + r * Math.cos(theta + alpha), cy + r * Math.sin(theta + alpha)],
    [cx + r * Math.cos(theta - alpha), cy + r * Math.sin(theta - alpha)],
  ];
}

/**
 * Snap candidates: tangent points from `from` to a circle (cx,cy,r).
 * Returns 0, 1, or 2 SnapPoints of type 'tangent'.
 *
 * @invariant Returns [] when from is null or strictly inside the circle.
 */
export function snapTangentToCircle(from: Vec2 | null, cx: number, cy: number, r: number): SnapPoint[] {
  if (from === null) return [];
  return tangentPointsToCircle(from[0], from[1], cx, cy, r).map(([x, y]) => ({
    x,
    y,
    type: 'tangent' as const,
  }));
}

/**
 * Snap along the extension of a segment (ax,ay)→(bx,by) beyond both endpoints.
 * Returns a snap point on the extended line closest to the cursor, but only
 * when the projection falls OUTSIDE the segment (t < 0 or t > 1).
 */
export function snapExtension(cursorX: number, cursorY: number, ax: number, ay: number, bx: number, by: number): SnapPoint | null {
  const t = footParameter(cursorX, cursorY, ax, ay, bx, by);
  if (t === null || (t >= 0 && t <= 1)) return null; // degenerate segment, or within it
  return { x: ax + t * (bx - ax), y: ay + t * (by - ay), type: 'extension' };
}

/**
 * Find the nearest point on a segment (ax,ay)→(bx,by) to cursor (px,py).
 * Returns the clamped foot point (t ∈ [0,1]).
 */
export function nearestOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const { t } = projectOntoSegment([px, py], [ax, ay], [bx, by]);
  return [ax + t * (bx - ax), ay + t * (by - ay)];
}

/**
 * Find the nearest point on a circle arc (or full circle) to cursor (px,py).
 * For a full circle (isFullCircle=true) returns the radial foot.
 * For an arc, clamps to the swept angle range.
 */
export function nearestOnArc(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  isFullCircle: boolean,
): [number, number] {
  if (isFullCircle) {
    const angle = Math.atan2(py - cy, px - cx);
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  }
  const sweep = wrapAngle(endAngle - startAngle);
  // Offset of the cursor direction, measured from startAngle.
  const offset = wrapAngle(Math.atan2(py - cy, px - cx) - startAngle);
  const clampedOffset = clamp(offset, 0, sweep);
  const clampedAngle = startAngle + clampedOffset;
  return [cx + r * Math.cos(clampedAngle), cy + r * Math.sin(clampedAngle)];
}
