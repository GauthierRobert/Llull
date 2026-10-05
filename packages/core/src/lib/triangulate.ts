/**
 * Pure polygon-with-holes triangulation (hole bridging + ear clipping). Small inputs only
 * (O(n²)); used to mesh slabs with openings. @layer lib
 */

import { pointInPolygon, polygonArea, segmentsIntersect, signedArea, type Point2 } from './polygon';

function cross(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function pointInTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}

/** True when `p` lies on segment a–b strictly between its ends. */
function onSegment(p: Point2, a: Point2, b: Point2): boolean {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length === 0 || Math.abs(cross(a, b, p)) > length * 1e-9 * Math.max(1, length)) return false;
  const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (length * length);
  return t > 1e-9 && t < 1 - 1e-9;
}

interface Vertex {
  readonly point: Point2;
  /** Index into the flat vertex list returned to the caller. */
  readonly index: number;
}

/** Splices `hole` into `ring` through the nearest mutually visible vertex pair. */
function bridge(
  ring: Vertex[],
  hole: Vertex[],
  obstacles: ReadonlyArray<ReadonlyArray<Vertex>>,
  extremity: (point: Point2) => number,
): Vertex[] {
  const holeStart = hole.reduce(
    (best, vertex, index) =>
      extremity(vertex.point) > extremity((hole[best] as Vertex).point) ? index : best,
    0,
  );
  const from = (hole[holeStart] as Vertex).point;
  const loops = [ring, hole, ...obstacles];
  const holes = [hole, ...obstacles].map((loop) => loop.map((vertex) => vertex.point));
  const outline = ring.map((vertex) => vertex.point);
  const visible = (to: Point2): boolean => {
    const at = (t: number): Point2 => [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
    ];
    const crossesEdge = loops.some((loop) =>
      loop.some((vertex, index) => {
        const next = (loop[(index + 1) % loop.length] as Vertex).point;
        return segmentsIntersect(from, to, vertex.point, next);
      }),
    );
    const grazesVertex = loops.some((loop) =>
      loop.some(({ point }) => point !== from && point !== to && onSegment(point, from, to)),
    );
    const samples = [at(1e-3), at(0.5), at(1 - 1e-3)];
    const leavesRegion = samples.some(
      (sample) =>
        !pointInPolygon(sample, outline) || holes.some((points) => pointInPolygon(sample, points)),
    );
    return !crossesEdge && !grazesVertex && !leavesRegion;
  };
  // A point already shared by an earlier bridge must not anchor another one (ears would overlap).
  const occurrences = new Map<number, number>();
  for (const vertex of ring)
    occurrences.set(vertex.index, (occurrences.get(vertex.index) ?? 0) + 1);
  let target = -1;
  let bestDistance = Infinity;
  ring.forEach((vertex, index) => {
    if ((occurrences.get(vertex.index) ?? 0) > 1) return;
    const distance = Math.hypot(vertex.point[0] - from[0], vertex.point[1] - from[1]);
    if (distance < bestDistance && visible(vertex.point)) {
      bestDistance = distance;
      target = index;
    }
  });
  if (target < 0) return ring;
  const rotatedHole = [...hole.slice(holeStart), ...hole.slice(0, holeStart)];
  return [
    ...ring.slice(0, target + 1),
    ...rotatedHole,
    rotatedHole[0] as Vertex,
    ring[target] as Vertex,
    ...ring.slice(target + 1),
  ];
}

/**
 * Triangulates `outer` minus `holes`.
 * @returns the flat vertex list (outer, then each hole, all as given), CCW index triples into it,
 *          and whether the whole region was covered (false when ear clipping stalled)
 */
interface Triangulation {
  readonly vertices: Point2[];
  readonly triangles: Array<[number, number, number]>;
  readonly complete: boolean;
}

/** Bridge anchors tried in turn: rightmost, leftmost, topmost, bottommost hole vertex. */
const EXTREMITIES: ReadonlyArray<(point: Point2) => number> = [
  (point) => point[0],
  (point) => -point[0],
  (point) => point[1],
  (point) => -point[1],
];

export function triangulatePolygon(
  outer: ReadonlyArray<Point2>,
  holes: ReadonlyArray<ReadonlyArray<Point2>> = [],
): Triangulation {
  let attempt = triangulateWith(outer, holes, EXTREMITIES[0] as (point: Point2) => number);
  for (const extremity of EXTREMITIES.slice(1)) {
    if (attempt.complete || holes.length === 0) break;
    attempt = triangulateWith(outer, holes, extremity);
  }
  return attempt;
}

function triangulateWith(
  outer: ReadonlyArray<Point2>,
  holes: ReadonlyArray<ReadonlyArray<Point2>>,
  extremity: (point: Point2) => number,
): Triangulation {
  const vertices: Point2[] = [];
  const toVertices = (points: ReadonlyArray<Point2>, wantCounterClockwise: boolean): Vertex[] => {
    const isCounterClockwise = signedArea(points) > 0;
    const ordered =
      isCounterClockwise === wantCounterClockwise ? [...points] : [...points].reverse();
    return ordered.map((point) => {
      vertices.push(point);
      return { point, index: vertices.length - 1 };
    });
  };
  let ring = toVertices(outer, true);
  const holeRings = holes.map((hole) => toVertices(hole, false));
  const reach = (loop: ReadonlyArray<Vertex>): number =>
    Math.max(...loop.map((vertex) => extremity(vertex.point)));
  const pending = [...holeRings].sort((a, b) => reach(b) - reach(a));
  for (const [index, hole] of pending.entries())
    ring = bridge(ring, hole, pending.slice(index + 1), extremity);

  const triangles: Array<[number, number, number]> = [];
  const remaining = [...ring];
  const neighbours = (i: number): [Vertex, Vertex, Vertex] => [
    remaining[(i - 1 + remaining.length) % remaining.length] as Vertex,
    remaining[i] as Vertex,
    remaining[(i + 1) % remaining.length] as Vertex,
  ];
  const same = (a: Point2, b: Point2): boolean => a[0] === b[0] && a[1] === b[1];
  let guard = remaining.length * remaining.length + 10;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < remaining.length && !clipped; i++) {
      const [previous, current, next] = neighbours(i);
      if (cross(previous.point, current.point, next.point) <= 1e-12) continue;
      // Only reflex (or flat) vertices can invalidate an ear (earcut rule).
      const blocked = remaining.some((other, j) => {
        if ([previous, current, next].some((corner) => same(corner.point, other.point)))
          return false;
        const [before, , after] = neighbours(j);
        if (cross(before.point, other.point, after.point) > 1e-12) return false;
        return pointInTriangle(other.point, previous.point, current.point, next.point);
      });
      if (blocked) continue;
      triangles.push([previous.index, current.index, next.index]);
      remaining.splice(i, 1);
      clipped = true;
    }
    if (clipped) continue;
    // Stalled: drop one flat or repeated vertex (area-neutral) and retry.
    const flat = remaining.findIndex((_, i) => {
      const [previous, current, next] = neighbours(i);
      return Math.abs(cross(previous.point, current.point, next.point)) <= 1e-12;
    });
    if (flat < 0) break;
    remaining.splice(flat, 1);
  }
  if (remaining.length === 3) {
    const [a, b, c] = remaining as [Vertex, Vertex, Vertex];
    if (cross(a.point, b.point, c.point) > 1e-12) triangles.push([a.index, b.index, c.index]);
  }
  const target = polygonArea(outer) - holes.reduce((sum, hole) => sum + polygonArea(hole), 0);
  const covered = triangles.reduce((sum, [a, b, c]) => {
    const [pa, pb, pc] = [vertices[a], vertices[b], vertices[c]] as [Point2, Point2, Point2];
    return sum + Math.abs(cross(pa, pb, pc)) / 2;
  }, 0);
  const complete = target > 0 && Math.abs(covered - target) <= target * 1e-6;
  return { vertices, triangles, complete };
}
