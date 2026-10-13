/** Pure planar polygon / segment helpers. @layer lib */

import { clamp01 } from './clamp';
import type { Vec2 } from '../model/vectors';
import { centroid2, lerp2, orient2 } from './vec2';

export type Point2 = Vec2;

/** Calls `visit(x1, y1, x2, y2, cross)` for each closed-polygon edge; cross = x1*y2 - x2*y1. */
function forEachEdge(points: ReadonlyArray<Point2>, visit: (x1: number, y1: number, x2: number, y2: number, cross: number) => void): void {
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i] as Point2;
    const [x2, y2] = points[(i + 1) % points.length] as Point2;
    visit(x1, y1, x2, y2, x1 * y2 - x2 * y1);
  }
}

/** Signed shoelace area; > 0 when counter-clockwise. */
export function signedArea(points: ReadonlyArray<Point2>): number {
  let twiceArea = 0;
  forEachEdge(points, (_x1, _y1, _x2, _y2, cross) => {
    twiceArea += cross;
  });
  return twiceArea / 2;
}

export function polygonArea(points: ReadonlyArray<Point2>): number {
  return Math.abs(signedArea(points));
}

/** Perimeter of the closed polygon. */
export function polygonPerimeter(points: ReadonlyArray<Point2>): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) total += distance(points[i] as Point2, points[(i + 1) % points.length] as Point2);
  return total;
}

/** Area centroid; falls back to the vertex average for degenerate (zero-area) input. */
export function polygonCentroid(points: ReadonlyArray<Point2>): Point2 {
  const area = signedArea(points);
  if (Math.abs(area) < 1e-12) return centroid2(points);
  let cx = 0;
  let cy = 0;
  forEachEdge(points, (x1, y1, x2, y2, cross) => {
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  });
  return [cx / (6 * area), cy / (6 * area)];
}

/** Returns the polygon in counter-clockwise order. */
export function toCounterClockwise(points: ReadonlyArray<Point2>): Point2[] {
  return signedArea(points) < 0 ? [...points].reverse() : [...points];
}

/** `point` rotated counter-clockwise by `angle` radians about the origin. */
export function rotatePoint2(point: Point2, angle: number): Point2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [point[0] * c - point[1] * s, point[0] * s + point[1] * c];
}

export function distance(a: Point2, b: Point2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Distance from `p` to segment `a`→`b` and the clamped parameter t ∈ [0,1] of the foot point. */
export function projectOntoSegment(p: Point2, a: Point2, b: Point2): { distance: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const rawT = lengthSquared === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared;
  const t = clamp01(rawT);
  return { distance: distance(p, [a[0] + t * dx, a[1] + t * dy]), t };
}

/** True when the polygon has ≥ 3 finite vertices and a non-zero area. */
export function isValidPolygon(points: ReadonlyArray<Point2>): boolean {
  return points.length >= 3 && points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) && polygonArea(points) > 1e-12;
}

/**
 * Offsets every edge of a closed polygon by `delta` along its outward normal (CCW input assumed; the result is computed on the CCW copy)
 * and joins consecutive edges with mitred corners. Parallel consecutive edges keep the shifted vertex.
 */
export function offsetPolygon(points: ReadonlyArray<Point2>, delta: number): Point2[] {
  const ccw = toCounterClockwise(points);
  const count = ccw.length;
  const shifted = ccw.map((point, index) => {
    const next = ccw[(index + 1) % count] as Point2;
    const length = distance(point, next) || 1;
    const normal: Point2 = [(next[1] - point[1]) / length, -(next[0] - point[0]) / length];
    return {
      a: [point[0] + normal[0] * delta, point[1] + normal[1] * delta] as Point2,
      b: [next[0] + normal[0] * delta, next[1] + normal[1] * delta] as Point2,
    };
  });
  return shifted.map((edge, index) => {
    const previous = shifted[(index - 1 + count) % count] as { a: Point2; b: Point2 };
    return lineIntersection(previous.a, previous.b, edge.a, edge.b) ?? edge.a;
  });
}

/**
 * Parameters `{ t, u }` of the crossing of the infinite lines P(t) = p + t(q − p) and Q(u) = r + u(s − r), or null when parallel/collinear.
 * t and u are not clamped to [0, 1].
 */
export function lineIntersectionParams(p: Point2, q: Point2, r: Point2, s: Point2): { t: number; u: number } | null {
  const dx1 = q[0] - p[0];
  const dy1 = q[1] - p[1];
  const dx2 = s[0] - r[0];
  const dy2 = s[1] - r[1];
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-12) return null;
  const dx3 = r[0] - p[0];
  const dy3 = r[1] - p[1];
  return { t: (dx3 * dy2 - dy3 * dx2) / denom, u: (dx3 * dy1 - dy3 * dx1) / denom };
}

/** Intersection of the infinite lines a1→a2 and b1→b2, or null when parallel. */
export function lineIntersection(a1: Point2, a2: Point2, b1: Point2, b2: Point2): Point2 | null {
  const hit = lineIntersectionParams(a1, a2, b1, b2);
  return hit === null ? null : lerp2(a1, a2, hit.t);
}

/** Crossing point of segments a1–a2 and b1–b2 (ends included), or null when parallel or apart. */
export function segmentIntersection(a1: Point2, a2: Point2, b1: Point2, b2: Point2): Point2 | null {
  const rx = a2[0] - a1[0];
  const ry = a2[1] - a1[1];
  const sx = b2[0] - b1[0];
  const sy = b2[1] - b1[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-10) return null;
  const t = ((b1[0] - a1[0]) * sy - (b1[1] - a1[1]) * sx) / denominator;
  const u = ((b1[0] - a1[0]) * ry - (b1[1] - a1[1]) * rx) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a1[0] + t * rx, a1[1] + t * ry] : null;
}

/** Even-odd point-in-polygon test (points on the boundary may go either way). */
export function pointInPolygon(point: Point2, polygon: ReadonlyArray<Point2>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Point2;
    const [xj, yj] = polygon[j] as Point2;
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when segments a1–a2 and b1–b2 cross at a single interior point (touching ends excluded). */
export function segmentsIntersect(a1: Point2, a2: Point2, b1: Point2, b2: Point2): boolean {
  const d1 = orient2(b1, b2, a1);
  const d2 = orient2(b1, b2, a2);
  const d3 = orient2(a1, a2, b1);
  const d4 = orient2(a1, a2, b2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
