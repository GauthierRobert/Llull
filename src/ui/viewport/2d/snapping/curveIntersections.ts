/**
 * @layer ui/viewport/2d
 *
 * Pure intersection helpers between segments and circular curves (circles / arcs).
 */

import { isAngleOnArc, type Segment } from './geometry';

/** Circular curve in world space; `full` = whole circle, else the CCW sweep startAngle→endAngle. */
export interface CircularCurve {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly full: boolean;
}

type Point = [number, number];

const onCurve = (curve: CircularCurve, x: number, y: number): boolean =>
  curve.full ||
  isAngleOnArc(Math.atan2(y - curve.cy, x - curve.cx), curve.startAngle, curve.endAngle);

/**
 * Intersections of a finite segment with a circle/arc (0, 1 or 2 points).
 * @failure degenerate segment or non-positive radius -> []
 */
export function segmentCurveIntersections(segment: Segment, curve: CircularCurve): Point[] {
  const [ax, ay, bx, by] = segment;
  const dx = bx - ax;
  const dy = by - ay;
  const a = dx * dx + dy * dy;
  if (a < 1e-20 || curve.r <= 0) return [];
  const fx = ax - curve.cx;
  const fy = ay - curve.cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - curve.r * curve.r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  const ts = root < 1e-12 ? [-b / (2 * a)] : [(-b - root) / (2 * a), (-b + root) / (2 * a)];
  const eps = 1e-9;
  return ts
    .filter((t) => t >= -eps && t <= 1 + eps)
    .map((t): Point => [ax + t * dx, ay + t * dy])
    .filter(([x, y]) => onCurve(curve, x, y));
}

/**
 * Intersections of two circles/arcs (0, 1 or 2 points); concentric curves yield none.
 */
export function curveCurveIntersections(p: CircularCurve, q: CircularCurve): Point[] {
  const dx = q.cx - p.cx;
  const dy = q.cy - p.cy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-10 || d > p.r + q.r + 1e-10 || d < Math.abs(p.r - q.r) - 1e-10) return [];
  const along = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
  const height = Math.sqrt(Math.max(0, p.r * p.r - along * along));
  const mx = p.cx + (along * dx) / d;
  const my = p.cy + (along * dy) / d;
  const points: Point[] =
    height < 1e-9
      ? [[mx, my]]
      : [
          [mx - (height * dy) / d, my + (height * dx) / d],
          [mx + (height * dy) / d, my - (height * dx) / d],
        ];
  return points.filter(([x, y]) => onCurve(p, x, y) && onCurve(q, x, y));
}
