/**
 * @layer ui/viewport/2d
 *
 * Pure 2D geometry helpers for snapping: segment extraction, intersections, and the
 * advanced snap constructions (perpendicular, tangent, extension, nearest).
 */

import type { Entity, Vec2 } from '@core/model/types';
import type { SnapPoint } from './types';

/** Euclidean distance between two 2D points. */
export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Midpoint of two 2D points. */
export function mid(ax: number, ay: number, bx: number, by: number): [number, number] {
  return [(ax + bx) / 2, (ay + by) / 2];
}

/**
 * Compute the intersection point of two line segments (if any).
 * Returns null when segments are parallel or do not intersect within their extents.
 */
export function segmentIntersection(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): [number, number] | null {
  const r_x = bx - ax;
  const r_y = by - ay;
  const s_x = dx - cx;
  const s_y = dy - cy;

  const denom = r_x * s_y - r_y * s_x;
  if (Math.abs(denom) < 1e-10) return null; // parallel

  const t = ((cx - ax) * s_y - (cy - ay) * s_x) / denom;
  const u = ((cx - ax) * r_y - (cy - ay) * r_x) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return [ax + t * r_x, ay + t * r_y];
  }
  return null;
}

/**
 * Extract line segments as [x1,y1,x2,y2] pairs from a 2D entity,
 * offset by the entity's world position.
 */
export function entityToSegments(entity: Entity): Array<[number, number, number, number]> {
  const ox = entity.position[0];
  const oy = entity.position[1];

  switch (entity.kind) {
    case 'line': {
      return [[entity.start[0] + ox, entity.start[1] + oy, entity.end[0] + ox, entity.end[1] + oy]];
    }
    case 'polyline': {
      const segs: Array<[number, number, number, number]> = [];
      const pts = entity.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        segs.push([a[0] + ox, a[1] + oy, b[0] + ox, b[1] + oy]);
      }
      if (entity.closed && pts.length >= 2) {
        const first = pts[0]!;
        const last = pts[pts.length - 1]!;
        segs.push([last[0] + ox, last[1] + oy, first[0] + ox, first[1] + oy]);
      }
      return segs;
    }
    case 'rectangle': {
      const x0 = ox;
      const y0 = oy;
      const x1 = ox + entity.width;
      const y1 = oy + entity.height;
      return [
        [x0, y0, x1, y0],
        [x1, y0, x1, y1],
        [x1, y1, x0, y1],
        [x0, y1, x0, y0],
      ];
    }
    default:
      return [];
  }
}

/**
 * Compute the foot of the perpendicular from point P to the infinite line
 * through (ax,ay)→(bx,by). Returns null when the segment has zero length.
 *
 * @pure
 */
export function perpendicularFoot(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): [number, number] | null {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-20) return null;
  const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  return [ax + t * dx, ay + t * dy];
}

/**
 * Snap perpendicular to a segment from reference point `from`.
 * Returns the foot point only when it lies within the segment extents (0 ≤ t ≤ 1).
 * When `from` is null the snap is skipped (no previous point).
 *
 * @pure
 */
export function snapPerpendicular(
  from: Vec2 | null,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): SnapPoint | null {
  if (from === null) return null;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-20) return null;
  const t = ((from[0] - ax) * dx + (from[1] - ay) * dy) / lenSq;
  if (t < 0 || t > 1) return null; // foot is outside segment
  return { x: ax + t * dx, y: ay + t * dy, type: 'perpendicular' };
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
 * @pure
 * @invariant Returns [] when px,py is strictly inside the circle.
 */
export function tangentPointsToCircle(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r: number,
): Array<[number, number]> {
  const dx = px - cx;
  const dy = py - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
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
 * @pure
 * @invariant Returns [] when from is null or strictly inside the circle.
 */
export function snapTangentToCircle(
  from: Vec2 | null,
  cx: number,
  cy: number,
  r: number,
): SnapPoint[] {
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
 *
 * @pure
 */
export function snapExtension(
  cursorX: number,
  cursorY: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): SnapPoint | null {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-20) return null;
  const t = ((cursorX - ax) * dx + (cursorY - ay) * dy) / lenSq;
  if (t >= 0 && t <= 1) return null; // within segment — not an extension
  const fx = ax + t * dx;
  const fy = ay + t * dy;
  return { x: fx, y: fy, type: 'extension' };
}

/**
 * Find the nearest point on a segment (ax,ay)→(bx,by) to cursor (px,py).
 * Returns the clamped foot point (t ∈ [0,1]).
 *
 * @pure
 */
export function nearestOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-20) return [ax, ay];
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return [ax + t * dx, ay + t * dy];
}

/**
 * Find the nearest point on a circle arc (or full circle) to cursor (px,py).
 * For a full circle (isFullCircle=true) returns the radial foot.
 * For an arc, clamps to the swept angle range.
 *
 * @pure
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
  // Normalize sweep to [0, 2π)
  const sweep = (((endAngle - startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const rawAngle = Math.atan2(py - cy, px - cx);
  // Offset to measure from startAngle
  const offset = (((rawAngle - startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const clampedOffset = Math.max(0, Math.min(sweep, offset));
  const clampedAngle = startAngle + clampedOffset;
  return [cx + r * Math.cos(clampedAngle), cy + r * Math.sin(clampedAngle)];
}
