/**
 * Planar polygon union of simple counter-clockwise polygons and convex clipping (aerospace 06 CMP §5.6 zone regions and ramps).
 * Edge-splitting union: both boundaries are cut at every mutual crossing, sub-edges inside the other polygon are dropped, coincident
 * sub-edges keep one copy (same direction) or vanish (opposite direction, the shared wall of two adjacent polygons), and the surviving
 * directed edges chain into rings. @layer lib
 */

import type { Vec2 } from '../model/vectors';
import { pointInPolygon, segmentIntersection, segmentsIntersect, signedArea, toCounterClockwise } from './polygon';

const SNAP = 1e-7;

const key = ([x, y]: Vec2): string => `${Math.round(x / SNAP)},${Math.round(y / SNAP)}`;
const samePoint = (a: Vec2, b: Vec2): boolean => Math.abs(a[0] - b[0]) <= SNAP && Math.abs(a[1] - b[1]) <= SNAP;

interface Edge {
  readonly a: Vec2;
  readonly b: Vec2;
}

const edgesOf = (ring: readonly Vec2[]): Edge[] => ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length] as Vec2 }));

/** Parameter of `p` along a -> b when `p` lies on the segment (within SNAP), else null. */
function paramOn(a: Vec2, b: Vec2, p: Vec2): number | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return null;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared;
  if (t < -SNAP || t > 1 + SNAP) return null;
  const foot: Vec2 = [a[0] + t * dx, a[1] + t * dy];
  return Math.hypot(foot[0] - p[0], foot[1] - p[1]) <= SNAP ? Math.min(1, Math.max(0, t)) : null;
}

/** `edges` of `ring` cut at every crossing / touching point with `other` (degenerate pieces dropped). */
function splitAgainst(ring: readonly Vec2[], other: readonly Vec2[]): Edge[] {
  return edgesOf(ring).flatMap(({ a, b }) => {
    const ts = new Set<number>([0, 1]);
    for (const [c, d] of edgesOf(other).map((e) => [e.a, e.b] as const)) {
      for (const end of [c, d]) {
        const t = paramOn(a, b, end);
        if (t !== null) ts.add(t);
      }
      const hit = segmentIntersection(a, b, c, d);
      const t = hit === null ? null : paramOn(a, b, hit);
      if (t !== null) ts.add(t);
    }
    const sorted = [...ts].sort((p, q) => p - q);
    const at = (t: number): Vec2 => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    return sorted.slice(1).flatMap((t, i): Edge[] => {
      const from = at(sorted[i] as number);
      const to = at(t);
      return samePoint(from, to) ? [] : [{ a: from, b: to }];
    });
  });
}

type Relation = 'inside' | 'outside' | 'same' | 'opposite';

/** Where the sub-edge lies against `other`: strictly inside, outside, or on its boundary (running the same / the opposite way). */
function relationOf(edge: Edge, other: readonly Vec2[]): Relation {
  const mid: Vec2 = [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2];
  for (const wall of edgesOf(other)) {
    if (paramOn(wall.a, wall.b, mid) === null) continue;
    const along = (edge.b[0] - edge.a[0]) * (wall.b[0] - wall.a[0]) + (edge.b[1] - edge.a[1]) * (wall.b[1] - wall.a[1]);
    return along >= 0 ? 'same' : 'opposite';
  }
  return pointInPolygon(mid, other) ? 'inside' : 'outside';
}

/** Rings chained from directed edges; an edge whose chain does not close is discarded. */
function chain(edges: readonly Edge[]): Vec2[][] {
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges) outgoing.set(key(edge.a), [...(outgoing.get(key(edge.a)) ?? []), edge]);
  const used = new Set<Edge>();
  const rings: Vec2[][] = [];
  for (const first of edges) {
    if (used.has(first)) continue;
    const ring: Vec2[] = [];
    let edge: Edge | undefined = first;
    while (edge !== undefined && !used.has(edge)) {
      used.add(edge);
      ring.push(edge.a);
      edge = (outgoing.get(key(edge.b)) ?? []).find((candidate) => !used.has(candidate));
    }
    if (ring.length >= 3 && samePoint(edge?.a ?? first.a, first.a)) rings.push(ring);
  }
  return rings;
}

/** `ring` without collinear or repeated vertices. */
function simplified(ring: readonly Vec2[]): Vec2[] {
  const kept = ring.filter((p, i) => {
    const previous = ring[(i - 1 + ring.length) % ring.length] as Vec2;
    const next = ring[(i + 1) % ring.length] as Vec2;
    if (samePoint(p, previous)) return false;
    const cross = (p[0] - previous[0]) * (next[1] - p[1]) - (p[1] - previous[1]) * (next[0] - p[0]);
    return Math.abs(cross) > 1e-9 * (1 + Math.hypot(next[0] - previous[0], next[1] - previous[1]));
  });
  return kept.length >= 3 ? kept : [...ring];
}

/** Union of two simple CCW polygons as the outer rings of the result. */
function unionPair(a: readonly Vec2[], b: readonly Vec2[]): Vec2[][] {
  const kept = [
    ...splitAgainst(a, b).filter((edge) => ['outside', 'same'].includes(relationOf(edge, b))),
    ...splitAgainst(b, a).filter((edge) => relationOf(edge, a) === 'outside'),
  ];
  const rings = chain(kept)
    .map(simplified)
    .filter((ring) => signedArea(ring) > 1e-9);
  if (rings.length > 0) return rings;
  return signedArea(a) >= signedArea(b) ? [[...a]] : [[...b]];
}

const onBoundary = (p: Vec2, polygon: readonly Vec2[]): boolean => edgesOf(polygon).some((edge) => paramOn(edge.a, edge.b, p) !== null);

/** True when the polygons share interior area or a wall (so their union is one region). */
function connected(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  const walls = (p: readonly Vec2[], q: readonly Vec2[]): boolean =>
    splitAgainst(p, q).some((edge) => ['same', 'opposite'].includes(relationOf(edge, q)));
  const crossing = edgesOf(a).some((e) => edgesOf(b).some((f) => segmentsIntersect(e.a, e.b, f.a, f.b)));
  const strict = (p: Vec2, polygon: readonly Vec2[]): boolean => pointInPolygon(p, polygon) && !onBoundary(p, polygon);
  return crossing || walls(a, b) || a.some((p) => strict(p, b)) || b.some((p) => strict(p, a));
}

/**
 * Union of simple polygons: the outer rings of the merged regions (counter-clockwise). Enclosed gaps (holes) are filled; polygons that
 * neither overlap nor share an edge stay separate rings.
 * @invariant polygons with fewer than 3 vertices are ignored; the result is ordered by first appearance
 */
export function unionPolygons(polygons: readonly (readonly Vec2[])[]): Vec2[][] {
  const result: Vec2[][] = [];
  for (const polygon of polygons) {
    if (polygon.length < 3) continue;
    let merged: Vec2[] = toCounterClockwise(polygon);
    for (
      let index = result.findIndex((ring) => connected(ring, merged));
      index >= 0;
      index = result.findIndex((ring) => connected(ring, merged))
    ) {
      const [ring] = result.splice(index, 1);
      const [first, ...extra] = unionPair(ring as Vec2[], merged);
      merged = first ?? merged;
      result.push(...extra);
    }
    result.push(merged);
  }
  return result;
}

/** True when every turn of the polygon has the same sense (a convex ring, collinear vertices allowed). */
export function isConvex(polygon: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Vec2;
    const b = polygon[(i + 1) % polygon.length] as Vec2;
    const c = polygon[(i + 2) % polygon.length] as Vec2;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign !== 0 && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/** Sutherland-Hodgman clip of `subject` by the convex counter-clockwise `clip`; empty when nothing remains. */
export function clipToConvex(subject: readonly Vec2[], clip: readonly Vec2[]): Vec2[] {
  const convex = toCounterClockwise(clip);
  let output: Vec2[] = [...subject];
  for (let i = 0; i < convex.length && output.length > 0; i++) {
    const a = convex[i] as Vec2;
    const b = convex[(i + 1) % convex.length] as Vec2;
    const side = (p: Vec2): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = output;
    output = [];
    input.forEach((p, j) => {
      const q = input[(j + 1) % input.length] as Vec2;
      const sp = side(p);
      const sq = side(q);
      if (sp >= -1e-12) output.push(p);
      if ((sp > 1e-12 && sq < -1e-12) || (sp < -1e-12 && sq > 1e-12)) {
        const t = sp / (sp - sq);
        output.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    });
  }
  return output.length >= 3 ? output : [];
}
