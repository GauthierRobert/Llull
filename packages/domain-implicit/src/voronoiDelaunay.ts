/**
 * Delaunay tetrahedralisation of the Voronoi seeds (05 IMP 14.14, 14.16): Bowyer-Watson with exact predicates, a visibility walk from the nearest earlier seed and a face-adjacency flood, on typed arrays.
 * @invariant predicates are exact (`voronoiPredicates.ts`): a tetrahedron is removed by a seed only when the seed is STRICTLY inside its circumsphere, so a cospherical seed is
 *   outside, the cavity of a seed is connected and star-shaped, and the result is a Delaunay triangulation (every circumsphere is empty, every face is shared by at most two
 *   tetrahedra) for any input, whatever the order the cavity is searched in: the flood and a scan of every tetrahedron give the same tetrahedra
 * @invariant an exact duplicate of an earlier seed is skipped (reported in `skipped`): it would make flat tetrahedra and add no Voronoi cell
 * @invariant tetrahedra are listed in creation order; the circumcentre (`c`, `r2`) is rounded to doubles and is only the position of the Voronoi vertex, never used to decide
 */

import type { Vec3 } from '@core/model/types';
import { inSphereIndexed, orient3dIndexed } from './voronoiPredicates';

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
  const lo = Math.min(a, b, c);
  const hi = Math.max(a, b, c);
  return (lo * count + (a + b + c - lo - hi)) * count + hi;
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

/** Opposite-vertex slots of the faces of a tetrahedron in the order `facesOf` lists them: abc (opposite d), abd, acd, bcd. */
const FACE_ORDER = [3, 2, 1, 0] as const;
/** The three vertex slots of the face opposite slot i, in the order `facesOf` lists them. */
const FACE_SLOTS = [
  [1, 2, 3],
  [0, 2, 3],
  [0, 1, 3],
  [0, 1, 2],
] as const;

/** Index of `value` among the four neighbour slots of tetrahedron `id`. */
const slotOf = (neighbours: Int32Array, id: number, value: number): number => {
  for (let i = 0; i < 4; i += 1) if (neighbours[4 * id + i] === value) return i;
  return -1;
};

/**
 * The triangulation of `points` (the last four are the enclosing tetrahedron). Typed arrays and face adjacency (the neighbour across the face opposite each vertex); the walk
 * starts from a tetrahedron around the nearest earlier seed (a grid of the inserted seeds), so a location costs a few steps instead of n^(1/3); the cavity is the flood over the
 * adjacency. Seeds are inserted in order and tetrahedra are listed in creation order with the vertex order of the first version: the output is the same list, value for value.
 */
export function triangulate(points: readonly Vec3[], real: number): Triangulation {
  const count = points.length;
  const coords = new Float64Array(3 * count);
  points.forEach((p, i) => {
    coords[3 * i] = p[0];
    coords[3 * i + 1] = p[1];
    coords[3 * i + 2] = p[2];
  });
  let capacity = Math.max(64, 16 * count);
  let verts: Int32Array = new Int32Array(4 * capacity);
  let neighbours: Int32Array = new Int32Array(4 * capacity).fill(-1);
  let orientation: Int8Array = new Int8Array(capacity);
  let alive: Uint8Array = new Uint8Array(capacity);
  let mark: Int32Array = new Int32Array(capacity);
  let total = 0;
  const grow = (): void => {
    capacity *= 2;
    const wider = (array: Int32Array | Int8Array | Uint8Array, per: number, fill?: number): Int32Array | Int8Array | Uint8Array => {
      const bigger = new (array.constructor as new (n: number) => Int32Array | Int8Array | Uint8Array)(per * capacity);
      if (fill !== undefined) bigger.fill(fill);
      bigger.set(array);
      return bigger;
    };
    verts = wider(verts, 4) as Int32Array;
    neighbours = wider(neighbours, 4, -1) as Int32Array;
    orientation = wider(orientation, 1) as Int8Array;
    alive = wider(alive, 1) as Uint8Array;
    mark = wider(mark, 1) as Int32Array;
  };
  const vertexTet = new Int32Array(count).fill(-1);

  /** A new tetrahedron (a, b, c, d); -1 when it is flat (never for a star-shaped cavity). */
  const create = (a: number, b: number, c: number, d: number): number => {
    const side = orient3dIndexed(coords, a, b, c, d);
    if (side === 0) return -1;
    if (total === capacity) grow();
    const id = total++;
    verts[4 * id] = a;
    verts[4 * id + 1] = b;
    verts[4 * id + 2] = c;
    verts[4 * id + 3] = d;
    orientation[id] = side;
    alive[id] = 1;
    vertexTet[a] = id;
    vertexTet[b] = id;
    vertexTet[c] = id;
    vertexTet[d] = id;
    return id;
  };
  const holds = (id: number, p: number): boolean =>
    alive[id] === 1 &&
    inSphereIndexed(
      coords,
      verts[4 * id] as number,
      verts[4 * id + 1] as number,
      verts[4 * id + 2] as number,
      verts[4 * id + 3] as number,
      p,
      orientation[id] as number,
    ) > 0;

  /** Visibility walk from `from` to a tetrahedron that contains point `p` (closed), or -1 when it does not settle. */
  const locate = (from: number, p: number): number => {
    let current = from;
    for (let step = 0; step < WALK_LIMIT; step += 1) {
      if (alive[current] !== 1) return -1;
      let moved = false;
      for (let k = 0; k < 4 && !moved; k += 1) {
        const i = (k + step) % 4;
        const corner = (slot: number): number => (slot === i ? p : (verts[4 * current + slot] as number));
        const side = orient3dIndexed(coords, corner(0), corner(1), corner(2), corner(3));
        if (side !== 0 && side !== orientation[current]) {
          const next = neighbours[4 * current + i] as number;
          if (next >= 0) {
            current = next;
            moved = true;
          }
        }
      }
      if (!moved) return current;
    }
    return -1;
  };

  // grid of the inserted seeds: the walk starts around the nearest one
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < real; i += 1)
    for (let axis = 0; axis < 3; axis += 1) {
      low[axis] = Math.min(low[axis] as number, coords[3 * i + axis] as number);
      high[axis] = Math.max(high[axis] as number, coords[3 * i + axis] as number);
    }
  const side = Math.max(1, Math.round(Math.cbrt(real / 2)));
  const cellOf = (p: number, axis: number): number => {
    const extent = (high[axis] as number) - (low[axis] as number);
    return extent > 0 ? Math.min(side - 1, Math.floor((((coords[3 * p + axis] as number) - (low[axis] as number)) / extent) * side)) : 0;
  };
  const head = new Int32Array(side * side * side).fill(-1);
  const chain = new Int32Array(Math.max(real, 1)).fill(-1);
  const startFor = (p: number, hint: number): number => {
    const [cx, cy, cz] = [cellOf(p, 0), cellOf(p, 1), cellOf(p, 2)];
    let best = -1;
    let bestDistance = Infinity;
    for (let dz = -1; dz <= 1; dz += 1)
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const [x, y, z] = [cx + dx, cy + dy, cz + dz];
          if (x < 0 || y < 0 || z < 0 || x >= side || y >= side || z >= side) continue;
          for (let q = head[(z * side + y) * side + x] as number; q >= 0; q = chain[q] as number) {
            const d =
              ((coords[3 * q] as number) - (coords[3 * p] as number)) ** 2 +
              ((coords[3 * q + 1] as number) - (coords[3 * p + 1] as number)) ** 2 +
              ((coords[3 * q + 2] as number) - (coords[3 * p + 2] as number)) ** 2;
            if (d < bestDistance) [best, bestDistance] = [q, d];
          }
        }
    const around = best >= 0 ? (vertexTet[best] as number) : -1;
    return around >= 0 && alive[around] === 1 ? around : hint;
  };

  const skipped: number[] = [];
  const seen = new Set<string>();
  create(real, real + 1, real + 2, real + 3);
  let hint = 0;
  let stamp = 0;
  for (let p = 0; p < real; p += 1) {
    const spot = `${coords[3 * p]},${coords[3 * p + 1]},${coords[3 * p + 2]}`;
    if (seen.has(spot)) {
      skipped.push(p);
      continue;
    }
    seen.add(spot);
    let start = locate(startFor(p, hint), p);
    if (start < 0 || !holds(start, p)) {
      start = -1;
      for (let id = 0; id < total && start < 0; id += 1) if (holds(id, p)) start = id;
    }
    if (start < 0) continue;
    // the cavity: the flood over the face adjacency from the tetrahedron that holds the seed
    stamp += 1;
    const cavity = [start];
    mark[start] = stamp;
    for (let at = 0; at < cavity.length; at += 1) {
      const id = cavity[at] as number;
      for (let i = 0; i < 4; i += 1) {
        const other = neighbours[4 * id + i] as number;
        if (other >= 0 && mark[other] !== stamp && holds(other, p)) {
          mark[other] = stamp;
          cavity.push(other);
        }
      }
    }
    cavity.sort((x, y) => x - y);
    // the boundary faces, in the order of the first version (cavity tetrahedra by id, faces abc, abd, acd, bcd)
    const boundary: Array<{ face: readonly [number, number, number]; outer: number; inner: number }> = [];
    for (const id of cavity)
      for (const i of FACE_ORDER) {
        const outer = neighbours[4 * id + i] as number;
        if (outer >= 0 && mark[outer] === stamp) continue;
        const slots = FACE_SLOTS[i];
        boundary.push({
          face: [verts[4 * id + slots[0]] as number, verts[4 * id + slots[1]] as number, verts[4 * id + slots[2]] as number],
          outer,
          inner: id,
        });
      }
    for (const id of cavity) alive[id] = 0;
    const open = new Map<number, number>();
    for (const { face, outer, inner } of boundary) {
      const id = create(face[0], face[1], face[2], p);
      if (id < 0) {
        if (outer >= 0) neighbours[4 * outer + slotOf(neighbours, outer, inner)] = -1;
        continue;
      }
      neighbours[4 * id + 3] = outer;
      if (outer >= 0) neighbours[4 * outer + slotOf(neighbours, outer, inner)] = id;
      // the three faces through the new seed are shared with the tetrahedra on the neighbouring boundary faces: matched by their common edge
      for (let i = 0; i < 3; i += 1) {
        const others = [0, 1, 2].filter((slot) => slot !== i).map((slot) => face[slot] as number);
        const key = Math.min(others[0] as number, others[1] as number) * count + Math.max(others[0] as number, others[1] as number);
        const waiting = open.get(key);
        if (waiting === undefined) open.set(key, id * 4 + i);
        else {
          open.delete(key);
          neighbours[4 * id + i] = Math.floor(waiting / 4);
          neighbours[4 * Math.floor(waiting / 4) + (waiting % 4)] = id;
        }
      }
      hint = id;
    }
    const cell = (cellOf(p, 2) * side + cellOf(p, 1)) * side + cellOf(p, 0);
    chain[p] = head[cell] as number;
    head[cell] = p;
  }
  const tets: Tet[] = [];
  for (let id = 0; id < total; id += 1) {
    if (alive[id] !== 1) continue;
    const v: Tet['v'] = [verts[4 * id] as number, verts[4 * id + 1] as number, verts[4 * id + 2] as number, verts[4 * id + 3] as number];
    const sphere = circumsphere(points[v[0]] as Vec3, points[v[1]] as Vec3, points[v[2]] as Vec3, points[v[3]] as Vec3) ?? {
      c: points[v[0]] as Vec3,
      r2: 0,
    };
    tets.push({ v, ...sphere });
  }
  return { tets, skipped };
}

/** Delaunay tetrahedra of `points` that do not touch the enclosing tetrahedron (the last four points), and the seeds skipped as duplicates. */
export function delaunay(points: readonly Vec3[], real: number): { readonly tets: Tet[]; readonly skipped: readonly number[] } {
  const { tets, skipped } = triangulate(points, real);
  return { tets: tets.filter((tet) => tet.v.every((index) => index < real)), skipped };
}
