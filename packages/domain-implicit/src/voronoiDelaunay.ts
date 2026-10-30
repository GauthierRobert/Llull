/**
 * Delaunay tetrahedralisation of the Voronoi seeds (05 IMP 14.14): Bowyer-Watson with exact predicates, a visibility walk and a face-adjacency flood.
 * @invariant predicates are exact (`voronoiPredicates.ts`): a tetrahedron is removed by a seed only when the seed is STRICTLY inside its circumsphere, so a cospherical seed is
 *   outside, the cavity of a seed is connected and star-shaped, and the result is a Delaunay triangulation (every circumsphere is empty, every face is shared by at most two
 *   tetrahedra) for any input, whatever the order the cavity is searched in: the flood and a scan of every tetrahedron give the same tetrahedra
 * @invariant an exact duplicate of an earlier seed is skipped (reported in `skipped`): it would make flat tetrahedra and add no Voronoi cell
 * @invariant tetrahedra are listed in creation order; the circumcentre (`c`, `r2`) is rounded to doubles and is only the position of the Voronoi vertex, never used to decide
 */

import type { Vec3 } from '@core/model/types';
import { inSphere, orient3d } from './voronoiPredicates';

export interface Tet {
  readonly v: readonly [number, number, number, number];
  readonly c: Vec3;
  readonly r2: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Circumsphere of four points rounded to doubles (position of a Voronoi vertex), or null when the double determinant vanishes. */
function circumsphere(a: Vec3, b: Vec3, c: Vec3, d: Vec3): { c: Vec3; r2: number } | null {
  const [u, v, w] = [sub(b, a), sub(c, a), sub(d, a)];
  const denominator = 2 * dot(u, cross(v, w));
  if (Math.abs(denominator) < 1e-300) return null;
  const [vw, wu, uv] = [cross(v, w), cross(w, u), cross(u, v)];
  const [lu, lv, lw] = [dot(u, u), dot(v, v), dot(w, w)];
  const offset: Vec3 = [
    (lu * vw[0] + lv * wu[0] + lw * uv[0]) / denominator,
    (lu * vw[1] + lv * wu[1] + lw * uv[1]) / denominator,
    (lu * vw[2] + lv * wu[2] + lw * uv[2]) / denominator,
  ];
  return { c: [a[0] + offset[0], a[1] + offset[1], a[2] + offset[2]], r2: dot(offset, offset) };
}

/** Exact key of the face (a, b, c) among `count` points (count^3 stays below 2^53 up to about 200000 points). */
export const faceKey = (a: number, b: number, c: number, count: number): number => {
  const [lo, mid, hi] = [a, b, c].sort((x, y) => x - y) as [number, number, number];
  return (lo * count + mid) * count + hi;
};

export const facesOf = ([a, b, c, d]: readonly [number, number, number, number]): ReadonlyArray<readonly [number, number, number]> => [
  [a, b, c],
  [a, b, d],
  [a, c, d],
  [b, c, d],
];

const WALK_LIMIT = 4096;

export interface Triangulation {
  /** Every tetrahedron of the triangulation (the enclosing ones included), in creation order. */
  readonly tets: readonly Tet[];
  /** Seeds skipped because an earlier seed sits at exactly the same place. */
  readonly skipped: readonly number[];
}

/** The triangulation of `points` (the last four are the enclosing tetrahedron). */
export function triangulate(points: readonly Vec3[], real: number): Triangulation {
  const count = points.length;
  const tets: Array<Tet | null> = [];
  const orientation: number[] = [];
  const faceTets = new Map<number, number[]>();
  const keysOf = (v: Tet['v']): number[] => facesOf(v).map((f) => faceKey(f[0], f[1], f[2], count));
  const at = (n: number): Vec3 => points[n] as Vec3;

  const add = (a: number, b: number, c: number, d: number): void => {
    const side = orient3d(at(a), at(b), at(c), at(d));
    if (side === 0) return;
    const sphere = circumsphere(at(a), at(b), at(c), at(d)) ?? { c: at(a), r2: 0 };
    const id = tets.length;
    const v: Tet['v'] = [a, b, c, d];
    tets.push({ v, ...sphere });
    orientation.push(side);
    for (const key of keysOf(v)) {
      const list = faceTets.get(key);
      if (list === undefined) faceTets.set(key, [id]);
      else list.push(id);
    }
  };
  const remove = (id: number): void => {
    const tet = tets[id] as Tet;
    for (const key of keysOf(tet.v)) {
      const list = faceTets.get(key) as number[];
      list.splice(list.indexOf(id), 1);
      if (list.length === 0) faceTets.delete(key);
    }
    tets[id] = null;
  };
  const neighbour = (id: number, a: number, b: number, c: number): number | null =>
    (faceTets.get(faceKey(a, b, c, count)) ?? []).find((other) => other !== id) ?? null;
  const holds = (id: number, point: Vec3): boolean => {
    const tet = tets[id];
    if (tet === null || tet === undefined) return false;
    return inSphere(at(tet.v[0]), at(tet.v[1]), at(tet.v[2]), at(tet.v[3]), point, orientation[id] as number) > 0;
  };

  /** Visibility walk from `from` to a tetrahedron that contains `point` (closed), or null when it does not settle. */
  const locate = (from: number, point: Vec3): number | null => {
    let current = from;
    for (let step = 0; step < WALK_LIMIT; step += 1) {
      const tet = tets[current];
      if (tet === null || tet === undefined) return null;
      let next: number | null = null;
      for (let k = 0; k < 4 && next === null; k += 1) {
        const i = (k + step) % 4;
        const corners = tet.v.map(at);
        corners[i] = point;
        const side = orient3d(corners[0] as Vec3, corners[1] as Vec3, corners[2] as Vec3, corners[3] as Vec3);
        if (side !== 0 && side !== orientation[current]) {
          const [a, b, c] = tet.v.filter((_, index) => index !== i) as [number, number, number];
          next = neighbour(current, a, b, c);
        }
      }
      if (next === null) return current;
      current = next;
    }
    return null;
  };

  const skipped: number[] = [];
  const seen = new Set<string>();
  add(real, real + 1, real + 2, real + 3);
  let hint = 0;
  for (let p = 0; p < real; p += 1) {
    const point = at(p);
    const spot = `${point[0]},${point[1]},${point[2]}`;
    if (seen.has(spot)) {
      skipped.push(p);
      continue;
    }
    seen.add(spot);
    let start = locate(hint, point);
    if (start === null || !holds(start, point)) start = tets.findIndex((_, id) => holds(id, point));
    if (start < 0) continue;
    const cavity = new Set<number>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop() as number;
      for (const [a, b, c] of facesOf((tets[id] as Tet).v)) {
        const other = neighbour(id, a, b, c);
        if (other !== null && !cavity.has(other) && holds(other, point)) {
          cavity.add(other);
          stack.push(other);
        }
      }
    }
    const faces = new Map<number, readonly [number, number, number] | null>();
    for (const id of [...cavity].sort((x, y) => x - y))
      for (const f of facesOf((tets[id] as Tet).v)) {
        const key = faceKey(f[0], f[1], f[2], count);
        faces.set(key, faces.has(key) ? null : f);
      }
    for (const id of cavity) remove(id);
    const before = tets.length;
    for (const f of faces.values()) if (f !== null) add(f[0], f[1], f[2], p);
    hint = tets.length > before ? tets.length - 1 : hint;
    while (tets[hint] === null && hint > 0) hint -= 1;
  }
  return { tets: tets.filter((tet): tet is Tet => tet !== null), skipped };
}

/** Delaunay tetrahedra of `points` that do not touch the enclosing tetrahedron (the last four points), and the seeds skipped as duplicates. */
export function delaunay(points: readonly Vec3[], real: number): { readonly tets: Tet[]; readonly skipped: readonly number[] } {
  const { tets, skipped } = triangulate(points, real);
  return { tets: tets.filter((tet) => tet.v.every((index) => index < real)), skipped };
}
