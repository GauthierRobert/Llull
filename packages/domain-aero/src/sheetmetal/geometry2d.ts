/** Planar helpers of the sheet-metal graph: rigid placements, half-plane clipping, simple-polygon tests, edge surgery. */

import type { Vec2 } from '@core/model/types';
import type { CurveSegment } from '@core/model/curve';
import { lerp2, orient2, perp2, sub2, dot2, normalize2 } from '@lib/vec2';
import { lineIntersection, polygonArea, signedArea, projectOntoSegment, segmentIntersection, segmentsIntersect } from '@lib/polygon';

/** Length tolerance of the planar helpers, in document units. */
export const EPS = 1e-9;

/** Rigid 2D placement: local (x, y) -> (x0 + c x - s y, y0 + s x + c y), angle in radians. */
export interface Rigid2 {
  readonly origin: Vec2;
  readonly angle: number;
}

export const IDENTITY: Rigid2 = { origin: [0, 0], angle: 0 };

export function applyRigid(t: Rigid2, [x, y]: Vec2): Vec2 {
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  return [t.origin[0] + c * x - s * y, t.origin[1] + s * x + c * y];
}

/** Placement of a child frame whose origin is at `origin` and whose x axis points along `direction`, both in `parent`'s local coordinates. */
export function composeRigid(parent: Rigid2, origin: Vec2, direction: Vec2): Rigid2 {
  return { origin: applyRigid(parent, origin), angle: parent.angle + Math.atan2(direction[1], direction[0]) };
}

/** Coordinates of `point` in the frame with origin `origin` and x axis `direction` (unit); y is the left normal. */
export function toLineFrame(point: Vec2, origin: Vec2, direction: Vec2): Vec2 {
  const offset = sub2(point, origin);
  return [dot2(offset, direction), dot2(offset, perp2(direction))];
}

/** Unit direction p -> q and its left normal (the outward side of a bend line). */
export function lineBasis(p: Vec2, q: Vec2): { readonly direction: Vec2; readonly outward: Vec2; readonly length: number } {
  const direction = normalize2(sub2(q, p), [1, 0]);
  return { direction, outward: perp2(direction), length: Math.hypot(q[0] - p[0], q[1] - p[1]) };
}

/** True when the polygon has >= 3 vertices, a non-zero area and no crossing edges. */
export function isSimplePolygon(points: readonly Vec2[]): boolean {
  const n = points.length;
  if (n < 3 || polygonArea(points) < EPS) return false;
  for (let i = 0; i < n; i++) {
    const a1 = points[i] as Vec2;
    const a2 = points[(i + 1) % n] as Vec2;
    if (Math.hypot(a2[0] - a1[0], a2[1] - a1[1]) < EPS) return false;
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(a1, a2, points[j] as Vec2, points[(j + 1) % n] as Vec2)) return false;
    }
  }
  return true;
}

/** Sutherland-Hodgman clip of a polygon to the half-plane `dot(P - point, normal) >= 0` (or `<= 0` when `keep` is 'negative'). */
export function clipHalfPlane(polygon: readonly Vec2[], point: Vec2, normal: Vec2, keep: 'positive' | 'negative'): Vec2[] {
  const sign = keep === 'positive' ? 1 : -1;
  const side = (p: Vec2): number => sign * dot2(sub2(p, point), normal);
  const out: Vec2[] = [];
  polygon.forEach((current, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length] as Vec2;
    const [sCurrent, sPrevious] = [side(current), side(previous)];
    if (sCurrent >= 0 !== sPrevious >= 0) out.push(lerp2(previous, current, sPrevious / (sPrevious - sCurrent)));
    if (sCurrent >= 0) out.push(current);
  });
  return dedupe(out);
}

/** Removes consecutive duplicate points (closed ring). */
export function dedupe(points: readonly Vec2[]): Vec2[] {
  return points.filter((p, i) => {
    const previous = points[(i + points.length - 1) % points.length] as Vec2;
    return Math.hypot(p[0] - previous[0], p[1] - previous[1]) > EPS;
  });
}

/** Points where the infinite line through `p` along `direction` crosses the polygon boundary, ordered along `direction`. */
export function lineCrossings(polygon: readonly Vec2[], p: Vec2, direction: Vec2): Vec2[] {
  const far: Vec2 = [p[0] + direction[0] * 1e9, p[1] + direction[1] * 1e9];
  const near: Vec2 = [p[0] - direction[0] * 1e9, p[1] - direction[1] * 1e9];
  const hits: Vec2[] = [];
  polygon.forEach((a, i) => {
    const hit = segmentIntersection(near, far, a, polygon[(i + 1) % polygon.length] as Vec2);
    if (hit !== null && !hits.some((known) => Math.hypot(known[0] - hit[0], known[1] - hit[1]) < 1e-7)) hits.push(hit);
  });
  return hits.sort((a, b) => dot2(a, direction) - dot2(b, direction));
}

/** Index of the polygon edge nearest `point` and the distance to it. */
export function nearestEdge(
  polygon: readonly Vec2[],
  point: Vec2,
): { readonly index: number; readonly distance: number; readonly t: number } {
  let best = { index: 0, distance: Infinity, t: 0 };
  polygon.forEach((a, index) => {
    const hit = projectOntoSegment(point, a, polygon[(index + 1) % polygon.length] as Vec2);
    if (hit.distance < best.distance - 1e-12) best = { index, distance: hit.distance, t: hit.t };
  });
  return best;
}

/**
 * The CCW polygon with edge `index` moved `shift` into the material (adjacent edges extended or trimmed to meet it).
 * @failure adjacent edge parallel to the moved one, or the result not simple -> null
 */
export function moveEdgeInward(polygon: readonly Vec2[], index: number, shift: number): Vec2[] | null {
  const n = polygon.length;
  const a = polygon[index] as Vec2;
  const b = polygon[(index + 1) % n] as Vec2;
  const inward = perp2(normalize2(sub2(b, a)));
  const a2: Vec2 = [a[0] + inward[0] * shift, a[1] + inward[1] * shift];
  const b2: Vec2 = [b[0] + inward[0] * shift, b[1] + inward[1] * shift];
  const startHit = lineIntersection(polygon[(index + n - 1) % n] as Vec2, a, a2, b2);
  const endHit = lineIntersection(b, polygon[(index + 2) % n] as Vec2, a2, b2);
  if (startHit === null || endHit === null) return null;
  const moved = polygon.map((point, i): Vec2 => (i === index ? startHit : i === (index + 1) % n ? endHit : point));
  return isSimplePolygon(moved) && signedArea(moved) > 0 ? moved : null;
}

/** Smallest distance between segments a1-a2 and b1-b2. */
export function segmentDistance(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  if (segmentIntersection(a1, a2, b1, b2) !== null) return 0;
  return Math.min(
    projectOntoSegment(a1, b1, b2).distance,
    projectOntoSegment(a2, b1, b2).distance,
    projectOntoSegment(b1, a1, a2).distance,
    projectOntoSegment(b2, a1, a2).distance,
  );
}

/** Smallest distance from the closed polygon boundary to the segment a-b. */
export function polygonToSegmentDistance(polygon: readonly Vec2[], a: Vec2, b: Vec2): number {
  return Math.min(...polygon.map((p, i) => segmentDistance(p, polygon[(i + 1) % polygon.length] as Vec2, a, b)));
}

/** Signed side of `point` relative to the directed line p -> q (> 0 left). */
export const sideOf = (p: Vec2, q: Vec2, point: Vec2): number => orient2(p, q, point) / (Math.hypot(q[0] - p[0], q[1] - p[1]) || 1);

/** Exact boundary of a circular cutout (two arcs), for the exact kernel. */
export function circleCurves([cx, cy]: Vec2, radius: number): CurveSegment<Vec2>[] {
  const at = (quarter: number): Vec2 => [cx + radius * Math.cos((quarter * Math.PI) / 2), cy + radius * Math.sin((quarter * Math.PI) / 2)];
  return [
    { type: 'arc', points: [at(0), at(1), at(2)] },
    { type: 'arc', points: [at(2), at(3), at(0)] },
  ];
}

/** CCW polygon of a circle with `count` vertices, starting on +x. */
export function circlePolygon([cx, cy]: Vec2, radius: number, count = 64): Vec2[] {
  return Array.from(
    { length: count },
    (_, i): Vec2 => [cx + radius * Math.cos((2 * Math.PI * i) / count), cy + radius * Math.sin((2 * Math.PI * i) / count)],
  );
}
