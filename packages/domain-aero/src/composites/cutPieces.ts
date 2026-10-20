/** Cutting a ply boundary into pieces along darts and splices (06 CMP FR-CMP-42): planar subdivision of the boundary and the cut paths. */

import type { PlyCut } from '@core/model/composites';
import type { Vec2 } from '@core/model/types';
import { pointInPolygon, polygonArea, projectOntoSegment, segmentIntersection, signedArea, toCounterClockwise } from '@lib/polygon';
import { clipToConvex, isConvex, unionPolygons } from '@lib/polygonBoolean';

type Segment = readonly [Vec2, Vec2];

const key = (p: Vec2, q: number): string => `${Math.round(p[0] / q)},${Math.round(p[1] / q)}`;

/** Parameter of `p` along segment a-b when p lies on it (within `eps` of the line), else null. */
function parameterOn(p: Vec2, [a, b]: Segment, eps: number): number | null {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = Math.hypot(dx, dy);
  if (length < eps) return null;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (length * length);
  const distance = Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length;
  return distance <= eps && t >= -eps / length && t <= 1 + eps / length ? Math.min(1, Math.max(0, t)) : null;
}

/** Sub-segments of every segment, cut at all mutual crossings and touching endpoints. */
function noded(segments: readonly Segment[], eps: number): Segment[] {
  return segments.flatMap((segment, index) => {
    const [a, b] = segment;
    const params = new Set<number>([0, 1]);
    segments.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      const crossing = segmentIntersection(a, b, other[0], other[1]);
      for (const p of crossing === null ? [other[0], other[1]] : [crossing, other[0], other[1]]) {
        const t = parameterOn(p, segment, eps);
        if (t !== null) params.add(t);
      }
    });
    const sorted = [...params].sort((x, y) => x - y);
    const at = (t: number): Vec2 => (t === 0 ? a : t === 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    return sorted.slice(1).map((t, k): Segment => [at(sorted[k] as number), at(t)]);
  });
}

/** Faces (counter-clockwise polygons) of the planar graph made of `segments`, dangling edges removed. */
function faces(segments: readonly Segment[], q: number): Vec2[][] {
  const point = new Map<string, Vec2>();
  const neighbours = new Map<string, Set<string>>();
  for (const [a, b] of segments) {
    const [ka, kb] = [key(a, q), key(b, q)];
    if (ka === kb) continue;
    point.set(ka, point.get(ka) ?? a);
    point.set(kb, point.get(kb) ?? b);
    neighbours.set(ka, (neighbours.get(ka) ?? new Set()).add(kb));
    neighbours.set(kb, (neighbours.get(kb) ?? new Set()).add(ka));
  }
  for (let pruned = true; pruned; ) {
    pruned = false;
    for (const [node, around] of neighbours)
      if (around.size < 2) {
        for (const other of around) neighbours.get(other)?.delete(node);
        neighbours.delete(node);
        pruned = true;
      }
  }
  const angle = (from: string, to: string): number => {
    const [a, b] = [point.get(from) as Vec2, point.get(to) as Vec2];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  const ring = new Map([...neighbours].map(([node, around]) => [node, [...around].sort((x, y) => angle(node, x) - angle(node, y))]));
  const visited = new Set<string>();
  const result: Vec2[][] = [];
  for (const [start, around] of ring)
    for (const first of around) {
      if (visited.has(`${start}>${first}`)) continue;
      const polygon: Vec2[] = [];
      let [from, to] = [start, first];
      while (!visited.has(`${from}>${to}`)) {
        visited.add(`${from}>${to}`);
        polygon.push(point.get(from) as Vec2);
        const list = ring.get(to) as string[];
        const next = list[(list.indexOf(from) - 1 + list.length) % list.length] as string;
        [from, to] = [to, next];
      }
      if (polygon.length >= 3 && signedArea(polygon) > q * q) result.push(polygon);
    }
  return result;
}

/** Ribbon of width `overlap` to the right of `path` (the side away from the piece that grows). */
function ribbon(path: readonly Vec2[], overlap: number): Vec2[] {
  const normals = path.map((_, k): Vec2 => {
    const [a, b] = [path[Math.max(0, k - 1)] as Vec2, path[Math.min(path.length - 1, k + 1)] as Vec2];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[1] - a[1]) / length, -(b[0] - a[0]) / length];
  });
  return [
    ...path,
    ...path.map((p, k): Vec2 => [p[0] + (normals[k] as Vec2)[0] * overlap, p[1] + (normals[k] as Vec2)[1] * overlap]).reverse(),
  ];
}

/** Index of the piece containing the point just left (`side` 1) or right (-1) of the middle of the longest segment of `path`, or -1. */
function sidePiece(pieces: readonly Vec2[][], path: readonly Vec2[], reach: number, side: 1 | -1): number {
  let best: Segment = [path[0] as Vec2, path[1] as Vec2];
  path.slice(1).forEach((p, k) => {
    const prior = path[k] as Vec2;
    if (Math.hypot(p[0] - prior[0], p[1] - prior[1]) > Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1])) best = [prior, p];
  });
  const [a, b] = best;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const probe: Vec2 = [
    (a[0] + b[0]) / 2 - side * ((b[1] - a[1]) / length) * reach,
    (a[1] + b[1]) / 2 + side * ((b[0] - a[0]) / length) * reach,
  ];
  return pieces.findIndex((piece) => pointInPolygon(probe, piece));
}

/**
 * The pieces of `boundary` after `cuts`.
 * @invariant pieces are counter-clockwise, sorted by their lowest-left vertex for a stable order; a dart or splice path is clipped to the
 *   boundary, a path that does not close a region (a lone dart) leaves the boundary unchanged; a splice overlap grows the piece on the left of
 *   the path direction by a ribbon of that width clipped to the neighbouring piece (skipped when that piece is not convex)
 */
export function cutPieces(boundary: readonly (readonly Vec2[])[], cuts: readonly PlyCut[]): Vec2[][] {
  if (cuts.length === 0) return boundary.map((polygon) => toCounterClockwise(polygon));
  const xs = boundary.flatMap((polygon) => polygon.map(([x]) => x));
  const ys = boundary.flatMap((polygon) => polygon.map(([, y]) => y));
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1e-9);
  const q = size * 1e-7;
  const eps = size * 1e-9;
  const pieces: Vec2[][] = [];
  for (const polygon of boundary) {
    const ring = toCounterClockwise(polygon);
    const edges: Segment[] = ring.map((a, k): Segment => [a, ring[(k + 1) % ring.length] as Vec2]);
    const paths: Segment[] = cuts.flatMap((cut) => cut.path.slice(1).map((b, k): Segment => [cut.path[k] as Vec2, b]));
    const cutEdges = noded([...edges, ...paths], eps).filter(([a, b]) => {
      const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      return pointInPolygon(mid, ring) || edges.some((edge) => parameterOn(mid, edge, eps * 10) !== null);
    });
    pieces.push(...faces(cutEdges, q));
  }
  pieces.sort(
    (a, b) =>
      Math.min(...a.map(([x]) => x)) - Math.min(...b.map(([x]) => x)) ||
      Math.min(...a.map(([, y]) => y)) - Math.min(...b.map(([, y]) => y)),
  );
  for (const cut of cuts) {
    if (cut.kind !== 'splice' || cut.overlap === undefined || cut.overlap <= 0) continue;
    const index = sidePiece(pieces, cut.path, size * 1e-4, 1);
    const other = sidePiece(pieces, cut.path, size * 1e-4, -1);
    if (index < 0 || other < 0 || index === other || !isConvex(pieces[other] as Vec2[])) continue;
    const strip = clipToConvex(ribbon(cut.path, cut.overlap), pieces[other] as Vec2[]);
    if (strip.length < 3) continue;
    const grown = unionPolygons([pieces[index] as Vec2[], toCounterClockwise(strip)]);
    const best = grown.sort((a, b) => polygonArea(b) - polygonArea(a))[0];
    if (best !== undefined) pieces[index] = toCounterClockwise(best);
  }
  return pieces;
}

export interface CutFace {
  readonly outer: Vec2[];
  /** Loops nested directly inside `outer` (disconnected from it), clockwise: the face is the region between them and `outer`. */
  readonly holes: Vec2[][];
}

const edgeDistance = (point: Vec2, polygon: readonly Vec2[]): number =>
  Math.min(...polygon.map((a, k) => projectOntoSegment(point, a, polygon[(k + 1) % polygon.length] as Vec2).distance));

const strictlyInside = (point: Vec2, polygon: readonly Vec2[]): boolean =>
  pointInPolygon(point, polygon) && edgeDistance(point, polygon) > 1e-9;

/** True when loop `inner` lies inside loop `outer` (smaller, every vertex in or on it, one strictly inside). */
function nestedIn(inner: readonly Vec2[], outer: readonly Vec2[]): boolean {
  return (
    polygonArea(inner) < polygonArea(outer) &&
    inner.every((vertex) => pointInPolygon(vertex, outer) || edgeDistance(vertex, outer) <= 1e-9) &&
    inner.some((vertex) => strictlyInside(vertex, outer))
  );
}

/**
 * `cutPieces` with nesting: a loop disconnected from and enclosed by another becomes a hole of its smallest enclosing loop, so concentric cuts
 * give annular faces instead of overlapping polygons.
 */
export function cutFaces(boundary: readonly (readonly Vec2[])[], cuts: readonly PlyCut[]): CutFace[] {
  const loops = cutPieces(boundary, cuts);
  const parent = loops.map((loop, index) => {
    let best = -1;
    loops.forEach((other, candidate) => {
      if (candidate !== index && nestedIn(loop, other) && (best < 0 || polygonArea(other) < polygonArea(loops[best] as Vec2[])))
        best = candidate;
    });
    return best;
  });
  return loops.map((outer, index) => ({
    outer,
    holes: loops.filter((_, child) => parent[child] === index).map((hole) => [...hole].reverse()),
  }));
}
