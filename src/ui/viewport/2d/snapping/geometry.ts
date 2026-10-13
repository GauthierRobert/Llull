// Pure 2D snap geometry: world segments, perpendicular / tangent / extension / nearest constructions.

import { clamp } from '@lib/clamp';
import type { Entity, Vec2 } from '@core/model/types';
import { entityPlanPoint } from '@core/geometry/entityFrame';
import { projectOntoSegment } from '@lib/polygon';
import { wrapAngle } from '@lib/angle';
import type { SnapPoint } from './types';
import { closeLoop, rectangleCorners } from '../../lineGeometry';

export type Segment = [number, number, number, number];

/** `angle` within the CCW sweep startAngle→endAngle (inclusive, with tolerance). */
export function isAngleOnArc(angle: number, startAngle: number, endAngle: number): boolean {
  const sweep = wrapAngle(endAngle - startAngle);
  const offset = wrapAngle(angle - startAngle);
  const eps = 1e-9;
  return offset <= sweep + eps || offset >= 2 * Math.PI - eps;
}

export function mid(ax: number, ay: number, bx: number, by: number): [number, number] {
  return [(ax + bx) / 2, (ay + by) / 2];
}

/** Entity-local point → world XY (rotation[2] about the origin, then position). */
export function localToWorld2D(entity: Entity, lx: number, ly: number): [number, number] {
  const [x, y] = entityPlanPoint(entity, [lx, ly]);
  return [x, y];
}

/** World-space segments of a line / polyline / rectangle. */
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
    case 'line':
      return [segmentBetween(entity.start, entity.end)];
    case 'polyline':
      return chain(entity.points, entity.closed);
    case 'rectangle':
      return chain(rectangleCorners(entity.width, entity.height), true);
    default:
      return [];
  }
}

/** Unclamped foot parameter of (px,py) on a→b. @failure a == b -> null */
function footParameter(px: number, py: number, ax: number, ay: number, bx: number, by: number): number | null {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  return lenSq < 1e-20 ? null : ((px - ax) * dx + (py - ay) * dy) / lenSq;
}

/** Foot from `from` onto the segment, only when within it; null without a previous point. */
export function snapPerpendicular(from: Vec2 | null, ax: number, ay: number, bx: number, by: number): SnapPoint | null {
  if (from === null) return null;
  const t = footParameter(from[0], from[1], ax, ay, bx, by);
  if (t === null || t < 0 || t > 1) return null;
  return { x: ax + t * (bx - ax), y: ay + t * (by - ay), type: 'perpendicular' };
}

/** Tangent points from P to circle C,r: φ = θ ± acos(r/d), since (T−C)⊥(P−T) ⇒ cos(φ−θ) = r/d. @invariant [] when P is strictly inside */
export function tangentPointsToCircle(px: number, py: number, cx: number, cy: number, r: number): Array<[number, number]> {
  const dx = px - cx;
  const dy = py - cy;
  const d = Math.hypot(dx, dy);
  if (d < r - 1e-10) return [];
  if (d < 1e-10) return [];
  const theta = Math.atan2(dy, dx);
  const alpha = Math.acos(Math.min(r / d, 1)); // clamp at d == r
  return [
    [cx + r * Math.cos(theta + alpha), cy + r * Math.sin(theta + alpha)],
    [cx + r * Math.cos(theta - alpha), cy + r * Math.sin(theta - alpha)],
  ];
}

/** @invariant [] when from is null or strictly inside the circle */
export function snapTangentToCircle(from: Vec2 | null, cx: number, cy: number, r: number): SnapPoint[] {
  if (from === null) return [];
  return tangentPointsToCircle(from[0], from[1], cx, cy, r).map(([x, y]) => ({ x, y, type: 'tangent' as const }));
}

/** Point on the line a→b nearest the cursor, only when it falls OUTSIDE the segment. */
export function snapExtension(cursorX: number, cursorY: number, ax: number, ay: number, bx: number, by: number): SnapPoint | null {
  const t = footParameter(cursorX, cursorY, ax, ay, bx, by);
  if (t === null || (t >= 0 && t <= 1)) return null;
  return { x: ax + t * (bx - ax), y: ay + t * (by - ay), type: 'extension' };
}

/** Clamped foot point (t ∈ [0,1]). */
export function nearestOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const { t } = projectOntoSegment([px, py], [ax, ay], [bx, by]);
  return [ax + t * (bx - ax), ay + t * (by - ay)];
}

/** Nearest point on the full circle, or on the arc clamped to its swept range. */
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
  const offset = wrapAngle(Math.atan2(py - cy, px - cx) - startAngle);
  const clampedOffset = clamp(offset, 0, sweep);
  const clampedAngle = startAngle + clampedOffset;
  return [cx + r * Math.cos(clampedAngle), cy + r * Math.sin(clampedAngle)];
}
