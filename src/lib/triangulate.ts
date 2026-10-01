/**
 * Pure polygon-with-holes triangulation (hole bridging + ear clipping). Small inputs only
 * (O(n²)); used to mesh slabs with openings. @layer lib
 */

import { signedArea, type Point2 } from './polygon';

function cross(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function pointInTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}

function segmentsCross(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
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
): Vertex[] {
  const holeStart = hole.reduce(
    (best, vertex, index) => (vertex.point[0] > (hole[best] as Vertex).point[0] ? index : best),
    0,
  );
  const from = (hole[holeStart] as Vertex).point;
  const loops = [ring, hole, ...obstacles];
  const visible = (to: Point2): boolean =>
    loops.every((loop) =>
      loop.every((vertex, index) => {
        const next = (loop[(index + 1) % loop.length] as Vertex).point;
        return !segmentsCross(from, to, vertex.point, next);
      }),
    );
  let target = -1;
  let bestDistance = Infinity;
  ring.forEach((vertex, index) => {
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
 * @returns the flat vertex list (outer, then each hole, all as given) and CCW index triples into it
 */
export function triangulatePolygon(
  outer: ReadonlyArray<Point2>,
  holes: ReadonlyArray<ReadonlyArray<Point2>> = [],
): { vertices: Point2[]; triangles: Array<[number, number, number]> } {
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
  const pending = [...holeRings].sort(
    (a, b) => Math.max(...b.map((v) => v.point[0])) - Math.max(...a.map((v) => v.point[0])),
  );
  for (const [index, hole] of pending.entries())
    ring = bridge(ring, hole, pending.slice(index + 1));

  const triangles: Array<[number, number, number]> = [];
  const remaining = [...ring];
  let guard = remaining.length * remaining.length + 10;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const previous = remaining[(i - 1 + remaining.length) % remaining.length] as Vertex;
      const current = remaining[i] as Vertex;
      const next = remaining[(i + 1) % remaining.length] as Vertex;
      if (cross(previous.point, current.point, next.point) <= 1e-12) continue;
      const blocked = remaining.some(
        (other) =>
          other !== previous &&
          other !== current &&
          other !== next &&
          other.index !== previous.index &&
          other.index !== current.index &&
          other.index !== next.index &&
          pointInTriangle(other.point, previous.point, current.point, next.point),
      );
      if (blocked) continue;
      triangles.push([previous.index, current.index, next.index]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (remaining.length === 3) {
    const [a, b, c] = remaining as [Vertex, Vertex, Vertex];
    if (cross(a.point, b.point, c.point) > 1e-12) triangles.push([a.index, b.index, c.index]);
  }
  return { vertices, triangles };
}
