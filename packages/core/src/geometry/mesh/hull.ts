/** 3D quickhull in double precision: closed outward-wound triangle mesh of a point set, coplanar points merged away. */

import type { Vec3 } from '../../model/vectors';
import { cross3, dot3, normalize3, sub3 } from '../../lib/vec3';
import { meshDiagonal } from './weld';

export interface HullMesh {
  /** Hull vertices (flat xyz), the subset of the input points that are corners of the hull, in first-use order. */
  readonly positions: number[];
  readonly triangles: number[];
}

interface Face {
  readonly corners: [number, number, number];
  normal: Vec3;
  offset: number;
  outside: number[];
  alive: boolean;
  /** Neighbour across edge k (corner k -> corner k+1). */
  adjacent: [Face | null, Face | null, Face | null];
}

/** Relative size of the "outside" slack: points within this x diameter of a face plane are treated as on it. */
const HULL_EPSILON = 1e-12;

const edgeIndexOf = (face: Face, from: number, to: number): number => {
  for (let k = 0; k < 3; k++) if (face.corners[k] === from && face.corners[(k + 1) % 3] === to) return k;
  return -1;
};

/**
 * Convex hull of flat xyz `points`.
 * @failure fewer than 4 non-coplanar points -> null
 * @invariant a point within 1e-12 x diameter of a face plane is not a hull vertex; output is deterministic for the same input order; each
 *   insertion walks only the visible region through face adjacency (no scan of all faces)
 */
export function convexHull(points: ReadonlyArray<number>): HullMesh | null {
  const count = Math.floor(points.length / 3);
  const at = (i: number): Vec3 => [points[i * 3] as number, points[i * 3 + 1] as number, points[i * 3 + 2] as number];
  if (count < 4) return null;
  const epsilon = HULL_EPSILON * meshDiagonal(points);
  const seed = initialSimplex(count, at, epsilon);
  if (seed === null) return null;
  const faces: Face[] = [];
  const distanceTo = (face: Face, point: Vec3): number => dot3(face.normal, point) - face.offset;
  const [i0, i1, i2, i3] = seed;
  const centre: Vec3 = [0, 1, 2].map(
    (k) => ((at(i0)[k] as number) + (at(i1)[k] as number) + (at(i2)[k] as number) + (at(i3)[k] as number)) / 4,
  ) as unknown as Vec3;
  const makeFace = (a: number, b: number, c: number): Face => {
    let normal = normalize3(cross3(sub3(at(b), at(a)), sub3(at(c), at(a))));
    let corners: [number, number, number] = [a, b, c];
    if (dot3(normal, sub3(centre, at(a))) > 0) {
      corners = [a, c, b];
      normal = [-normal[0], -normal[1], -normal[2]];
    }
    const face: Face = { corners, normal, offset: dot3(normal, at(corners[0])), outside: [], alive: true, adjacent: [null, null, null] };
    faces.push(face);
    return face;
  };
  const start = [makeFace(i0, i1, i2), makeFace(i0, i1, i3), makeFace(i0, i2, i3), makeFace(i1, i2, i3)];
  for (const face of start) {
    for (let k = 0; k < 3; k++) {
      const [from, to] = [face.corners[k] as number, face.corners[(k + 1) % 3] as number];
      const twin = start.find((other) => other !== face && edgeIndexOf(other, to, from) >= 0);
      if (twin !== undefined) face.adjacent[k] = twin;
    }
  }
  const simplex = new Set(seed);
  for (let p = 0; p < count; p++) {
    if (simplex.has(p)) continue;
    const point = at(p);
    const face = start.find((f) => distanceTo(f, point) > epsilon);
    if (face !== undefined) face.outside.push(p);
  }
  const pending: Face[] = [...start];
  while (pending.length > 0) {
    const face = pending.pop() as Face;
    if (!face.alive || face.outside.length === 0) continue;
    let apex = face.outside[0] as number;
    let best = -Infinity;
    for (const p of face.outside) {
      const distance = distanceTo(face, at(p));
      if (distance > best) [best, apex] = [distance, p];
    }
    const eye = at(apex);
    const visible = new Set<Face>([face]);
    const queue: Face[] = [face];
    const horizon: Array<{ from: number; to: number; across: Face }> = [];
    while (queue.length > 0) {
      const current = queue.pop() as Face;
      for (let k = 0; k < 3; k++) {
        const neighbour = current.adjacent[k];
        if (neighbour === null || neighbour === undefined) continue;
        if (visible.has(neighbour)) continue;
        if (neighbour.alive && distanceTo(neighbour, eye) > epsilon) {
          visible.add(neighbour);
          queue.push(neighbour);
        } else horizon.push({ from: current.corners[k] as number, to: current.corners[(k + 1) % 3] as number, across: neighbour });
      }
    }
    const orphans = [...visible].flatMap((f) => f.outside).filter((p) => p !== apex);
    for (const f of visible) f.alive = false;
    const created: Face[] = [];
    const byFrom = new Map<number, Face>();
    const byTo = new Map<number, Face>();
    for (const edge of horizon) {
      const fresh: Face = {
        corners: [edge.from, edge.to, apex],
        normal: [0, 0, 0],
        offset: 0,
        outside: [],
        alive: true,
        adjacent: [edge.across, null, null],
      };
      let normal = normalize3(cross3(sub3(at(edge.to), at(edge.from)), sub3(eye, at(edge.from))));
      if (dot3(normal, sub3(centre, at(edge.from))) > 0) normal = [-normal[0], -normal[1], -normal[2]];
      fresh.normal = normal;
      fresh.offset = dot3(normal, at(edge.from));
      const slot = edgeIndexOf(edge.across, edge.to, edge.from);
      if (slot >= 0) edge.across.adjacent[slot] = fresh;
      byFrom.set(edge.from, fresh);
      byTo.set(edge.to, fresh);
      created.push(fresh);
      faces.push(fresh);
    }
    for (const fresh of created) {
      fresh.adjacent[1] = byFrom.get(fresh.corners[1]) ?? null;
      fresh.adjacent[2] = byTo.get(fresh.corners[0]) ?? null;
    }
    for (const p of orphans) {
      const point = at(p);
      const owner = created.find((f) => distanceTo(f, point) > epsilon);
      if (owner !== undefined) owner.outside.push(p);
    }
    pending.push(...created);
  }
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const triangles: number[] = [];
  for (const face of faces) {
    if (!face.alive) continue;
    for (const v of face.corners) {
      let mapped = remap.get(v);
      if (mapped === undefined) {
        mapped = positions.length / 3;
        remap.set(v, mapped);
        positions.push(...at(v));
      }
      triangles.push(mapped);
    }
  }
  return { positions, triangles };
}

function initialSimplex(count: number, at: (i: number) => Vec3, epsilon: number): [number, number, number, number] | null {
  let [lo, hi] = [0, 0];
  for (let axis = 0; axis < 3; axis++) {
    let [min, max] = [0, 0];
    for (let i = 1; i < count; i++) {
      if ((at(i)[axis] as number) < (at(min)[axis] as number)) min = i;
      if ((at(i)[axis] as number) > (at(max)[axis] as number)) max = i;
    }
    if (Math.hypot(...sub3(at(max), at(min))) > Math.hypot(...sub3(at(hi), at(lo)))) [lo, hi] = [min, max];
  }
  const axis = sub3(at(hi), at(lo));
  if (Math.hypot(...axis) <= epsilon) return null;
  const lineDistance = (i: number): number => Math.hypot(...cross3(axis, sub3(at(i), at(lo)))) / Math.hypot(...axis);
  let third = -1;
  let thirdDistance = epsilon;
  for (let i = 0; i < count; i++) {
    const d = lineDistance(i);
    if (d > thirdDistance) [third, thirdDistance] = [i, d];
  }
  if (third < 0) return null;
  const normal = normalize3(cross3(axis, sub3(at(third), at(lo))));
  let fourth = -1;
  let fourthDistance = epsilon;
  for (let i = 0; i < count; i++) {
    const d = Math.abs(dot3(normal, sub3(at(i), at(lo))));
    if (d > fourthDistance) [fourth, fourthDistance] = [i, d];
  }
  return fourth < 0 ? null : [lo, hi, third, fourth];
}
