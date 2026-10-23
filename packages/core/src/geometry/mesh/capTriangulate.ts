/**
 * Watertight polygon triangulation for plane-cut caps: ear clipping on a polygon with holes (holes bridged to the outline) that keeps every
 * input vertex, including collinear ones, so the cap shares each section edge with the clipped mesh (no T-junctions).
 * @invariant every returned triangle has positive area and the triangles cover the polygon exactly; `complete` is false when clipping stalled
 */

export type Point2 = readonly [number, number];

interface RingVertex {
  /** Index into the concatenated input list (outer, then each hole). */
  readonly id: number;
  readonly p: Point2;
}

export interface CapTriangulation {
  readonly triangles: Array<[number, number, number]>;
  readonly complete: boolean;
}

const orient = (a: Point2, b: Point2, c: Point2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const same = (a: Point2, b: Point2): boolean => a[0] === b[0] && a[1] === b[1];

function signedArea(ring: ReadonlyArray<{ p: Point2 }>): number {
  return ring.reduce((s, v, k) => {
    const q = (ring[(k + 1) % ring.length] as { p: Point2 }).p;
    return s + (v.p[0] * q[1] - q[0] * v.p[1]) / 2;
  }, 0);
}

function inside(point: Point2, ring: ReadonlyArray<{ p: Point2 }>): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [(ring[i] as { p: Point2 }).p, (ring[j] as { p: Point2 }).p];
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** True when segments ab and cd cross at a point interior to both, or one end touches the other segment's interior. */
function cross(a: Point2, b: Point2, c: Point2, d: Point2, eps: number): boolean {
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  const [o1, o2, o3, o4] = [orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)];
  if (o1 * o2 < -eps * eps && o3 * o4 < -eps * eps) return true;
  const onSegment = (p: Point2, q: Point2, r: Point2): boolean =>
    Math.abs(orient(p, q, r)) <= eps &&
    r[0] >= Math.min(p[0], q[0]) - 1e-15 &&
    r[0] <= Math.max(p[0], q[0]) + 1e-15 &&
    r[1] >= Math.min(p[1], q[1]) - 1e-15 &&
    r[1] <= Math.max(p[1], q[1]) + 1e-15;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/** Clip the ears of one ring (strictly convex corners, no vertex inside or on the new diagonal); false when no ear is left. */
function clipRing(ringInput: RingVertex[], eps: number, out: Array<[number, number, number]>): boolean {
  const ring = [...ringInput];
  let guard = ring.length * ring.length + 10;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < ring.length && !clipped; i++) {
      const [prev, cur, next] = [ring[(i + ring.length - 1) % ring.length], ring[i], ring[(i + 1) % ring.length]] as [
        RingVertex,
        RingVertex,
        RingVertex,
      ];
      if (orient(prev.p, cur.p, next.p) <= eps) continue;
      const blocked = ring.some((other) => {
        if (same(other.p, prev.p) || same(other.p, cur.p) || same(other.p, next.p)) return false;
        return orient(prev.p, cur.p, other.p) >= -eps && orient(cur.p, next.p, other.p) >= -eps && orient(next.p, prev.p, other.p) >= -eps;
      });
      if (blocked) continue;
      out.push([prev.id, cur.id, next.id]);
      ring.splice(i, 1);
      clipped = true;
    }
    if (!clipped) return false;
  }
  if (ring.length === 3) {
    const [a, b, c] = ring as [RingVertex, RingVertex, RingVertex];
    if (orient(a.p, b.p, c.p) <= eps) return false;
    out.push([a.id, b.id, c.id]);
  }
  return true;
}

/**
 * Triangulate `outer` minus `holes`; indices refer to the concatenation [...outer, ...holes[0], ...holes[1], ...]. Any winding is accepted;
 * triangles come out counter-clockwise.
 */
export function triangulateCap(outer: ReadonlyArray<Point2>, holes: ReadonlyArray<ReadonlyArray<Point2>>): CapTriangulation {
  let offset = 0;
  const makeRing = (points: ReadonlyArray<Point2>, counterClockwise: boolean): RingVertex[] => {
    const ring = points.map((p, k) => ({ id: offset + k, p }));
    offset += points.length;
    return signedArea(ring) > 0 === counterClockwise ? ring : ring.reverse();
  };
  const outline = makeRing(outer, true);
  const holeRings = holes.map((hole) => makeRing(hole, false));
  const scale = Math.max(1e-300, ...outer.flatMap((p) => [Math.abs(p[0]), Math.abs(p[1])]));
  const eps = 1e-12 * scale * scale;
  let ring = outline;
  const pending = [...holeRings].sort((a, b) => Math.max(...b.map((v) => v.p[0])) - Math.max(...a.map((v) => v.p[0])));
  for (const hole of pending) {
    const start = hole.reduce((best, v, k) => (v.p[0] > (hole[best] as RingVertex).p[0] ? k : best), 0);
    const from = (hole[start] as RingVertex).p;
    const edges = [ring, ...pending.filter((h) => h !== hole)].flatMap((r) =>
      r.map((v, k) => [v.p, (r[(k + 1) % r.length] as RingVertex).p] as const),
    );
    const holeEdges = hole.map((v, k) => [v.p, (hole[(k + 1) % hole.length] as RingVertex).p] as const);
    let target = -1;
    let best = Infinity;
    ring.forEach((v, k) => {
      const d = Math.hypot(v.p[0] - from[0], v.p[1] - from[1]);
      if (d >= best) return;
      const blocked = [...edges, ...holeEdges].some(([a, b]) => cross(from, v.p, a, b, eps));
      const grazes = [...ring, ...hole].some(
        (o) =>
          !same(o.p, from) &&
          !same(o.p, v.p) &&
          Math.abs(orient(from, v.p, o.p)) <= eps &&
          (o.p[0] - from[0]) * (o.p[0] - v.p[0]) + (o.p[1] - from[1]) * (o.p[1] - v.p[1]) < 0,
      );
      const mid: Point2 = [(from[0] + v.p[0]) / 2, (from[1] + v.p[1]) / 2];
      if (!blocked && !grazes && inside(mid, outline) && !pending.some((h) => h !== hole && inside(mid, h)) && !inside(mid, hole)) {
        best = d;
        target = k;
      }
    });
    if (target < 0) return { triangles: [], complete: false };
    const rotated = [...hole.slice(start), ...hole.slice(0, start)];
    ring = [...ring.slice(0, target + 1), ...rotated, rotated[0] as RingVertex, ring[target] as RingVertex, ...ring.slice(target + 1)];
  }
  const triangles: Array<[number, number, number]> = [];
  const ok = clipRing(ring, eps, triangles);
  const all = [...outer, ...holes.flat()];
  const target = Math.abs(signedArea(outline)) - holeRings.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
  const covered = triangles.reduce((s, [a, b, c]) => s + Math.abs(orient(all[a] as Point2, all[b] as Point2, all[c] as Point2)) / 2, 0);
  return { triangles, complete: ok && target > 0 && Math.abs(covered - target) <= target * 1e-9 };
}
