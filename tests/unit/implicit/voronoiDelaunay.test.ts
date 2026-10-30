/** Delaunay of the Voronoi seeds (05 IMP 14.13): the walk + flood Bowyer-Watson returns the same tetrahedra in the same order as the quadratic scan it replaced (kept here as the reference). */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/types';
import { delaunay } from '@implicit/voronoiDelaunay';

interface RefTet {
  readonly v: readonly [number, number, number, number];
  readonly c: Vec3;
  readonly r2: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Circumsphere of four points, or null when they are coplanar. */
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

const refFaceKey = (a: number, b: number, c: number): string => [a, b, c].sort((x, y) => x - y).join(',');

const refFacesOf = ([a, b, c, d]: readonly [number, number, number, number]): ReadonlyArray<readonly [number, number, number]> => [
  [a, b, c],
  [a, b, d],
  [a, c, d],
  [b, c, d],
];

/** Delaunay tetrahedra of `points` (the last four points are the enclosing tetrahedron) that do not touch it. */
function referenceDelaunay(points: readonly Vec3[], real: number): RefTet[] {
  let tets: RefTet[] = [];
  const add = (a: number, b: number, c: number, d: number): void => {
    const sphere = circumsphere(points[a] as Vec3, points[b] as Vec3, points[c] as Vec3, points[d] as Vec3);
    if (sphere !== null) tets.push({ v: [a, b, c, d], ...sphere });
  };
  add(real, real + 1, real + 2, real + 3);
  for (let p = 0; p < real; p += 1) {
    const point = points[p] as Vec3;
    const bad: RefTet[] = [];
    const rest: RefTet[] = [];
    for (const tet of tets) {
      const d = sub(point, tet.c);
      (dot(d, d) < tet.r2 * (1 - 1e-12) ? bad : rest).push(tet);
    }
    const faces = new Map<string, readonly [number, number, number] | null>();
    for (const { v } of bad)
      for (const f of refFacesOf(v)) {
        const key = refFaceKey(f[0], f[1], f[2]);
        faces.set(key, faces.has(key) ? null : f);
      }
    tets = rest;
    for (const f of faces.values()) if (f !== null) add(f[0], f[1], f[2], p);
  }
  return tets.filter((tet) => tet.v.every((index) => index < real));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seeds and the enclosing tetrahedron of `voronoiGeometry`. */
function seeds(points: Vec3[], extent: number): Vec3[] {
  const centre: Vec3 = [extent / 2, extent / 2, extent / 2];
  const reach = 1000 * extent;
  const outer = (
    [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
    ] as const
  ).map((s): Vec3 => [centre[0] + s[0] * reach, centre[1] + s[1] * reach, centre[2] + s[2] * reach]);
  return [...points, ...outer];
}

const sameTets = (
  a: ReadonlyArray<{ v: readonly number[]; r2: number }>,
  b: ReadonlyArray<{ v: readonly number[]; r2: number }>,
): boolean => a.length === b.length && a.every((tet, i) => tet.v.every((n, k) => n === b[i]?.v[k]) && Object.is(tet.r2, b[i]?.r2));

describe('delaunay (walk + flood Bowyer-Watson)', () => {
  it.each([
    [40, 1],
    [200, 7],
    [500, 3],
    [1200, 11],
    [1200, 12],
  ])('returns the tetrahedra of the quadratic scan, in the same order, for %i seeded points (seed %i)', (count, seed) => {
    const random = mulberry32(seed);
    const points = Array.from({ length: count }, (): Vec3 => [random() * 20, random() * 20, random() * 20]);
    const all = seeds(points, 20);
    const fast = delaunay(all, count);
    const reference = referenceDelaunay(all, count);
    expect(fast.length).toBeGreaterThan(count * 4);
    expect(sameTets(fast, reference)).toBe(true);
  });

  it('keeps the quadratic order on a cospherical lattice too (every cube of a regular grid has one sphere)', () => {
    const points: Vec3[] = [];
    for (let i = 0; i < 5; i += 1) for (let j = 0; j < 5; j += 1) for (let k = 0; k < 5; k += 1) points.push([i, j, k]);
    const all = seeds(points, 4);
    expect(sameTets(delaunay(all, points.length), referenceDelaunay(all, points.length))).toBe(true);
  });

  it('skips a point that no circumsphere holds, like the scan', () => {
    const points: Vec3[] = [
      [1, 1, 1],
      [1, 1, 1],
      [2, 3, 4],
      [5, 1, 2],
      [3, 3, 1],
      [4, 5, 2],
    ];
    const all = seeds(points, 6);
    expect(sameTets(delaunay(all, points.length), referenceDelaunay(all, points.length))).toBe(true);
  });
});
