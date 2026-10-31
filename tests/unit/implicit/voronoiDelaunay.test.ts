/**
 * Delaunay of the Voronoi seeds (05 IMP 14.14): exact predicates, walk + flood Bowyer-Watson. The result is a true Delaunay triangulation (empty circumspheres, faces shared by at
 * most two tetrahedra, volumes tiling the enclosing tetrahedron) on random, jittered, near-cospherical, cospherical, duplicate and coplanar seeds, and it equals a slow reference
 * that scans every tetrahedron for the exact conflict set.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/types';
import { delaunay, faceKey, facesOf, triangulate } from '@implicit/voronoiDelaunay';
import { inSphere, inSphereIndexed, orient3d, orient3dIndexed } from '@implicit/voronoiPredicates';

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
function withEnclosure(points: Vec3[], extent: number): Vec3[] {
  const c = extent / 2;
  const reach = 1000 * extent;
  return [
    ...points,
    [c + reach, c + reach, c + reach],
    [c + reach, c - reach, c - reach],
    [c - reach, c + reach, c - reach],
    [c - reach, c - reach, c + reach],
  ];
}

type Corners = [Vec3, Vec3, Vec3, Vec3];

/** The slow reference: Bowyer-Watson with a scan of every tetrahedron for the exact conflict set. */
function referenceTriangulation(points: readonly Vec3[], real: number): number[][] {
  const tets: Array<{ v: [number, number, number, number]; side: number } | null> = [];
  const add = (a: number, b: number, c: number, d: number): void => {
    const side = orient3d(points[a] as Vec3, points[b] as Vec3, points[c] as Vec3, points[d] as Vec3);
    if (side !== 0) tets.push({ v: [a, b, c, d], side });
  };
  add(real, real + 1, real + 2, real + 3);
  const seen = new Set<string>();
  for (let p = 0; p < real; p += 1) {
    const point = points[p] as Vec3;
    const spot = point.join(',');
    if (seen.has(spot)) continue;
    seen.add(spot);
    const bad = tets.flatMap((tet, id) =>
      tet !== null && inSphere(...(tet.v.map((n) => points[n]) as Corners), point, tet.side) > 0 ? [id] : [],
    );
    const faces = new Map<number, readonly [number, number, number] | null>();
    for (const id of bad)
      for (const f of facesOf((tets[id] as { v: [number, number, number, number] }).v)) {
        const key = faceKey(f[0], f[1], f[2], points.length);
        faces.set(key, faces.has(key) ? null : f);
      }
    for (const id of bad) tets[id] = null;
    for (const f of faces.values()) if (f !== null) add(f[0], f[1], f[2], p);
  }
  return tets.flatMap((tet) => (tet === null ? [] : [tet.v]));
}

const volumeOf = ([a, b, c, d]: Corners): number =>
  Math.abs(
    (b[0] - a[0]) * ((c[1] - a[1]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[1] - a[1])) -
      (b[1] - a[1]) * ((c[0] - a[0]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[0] - a[0])) +
      (b[2] - a[2]) * ((c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0])),
  ) / 6;

function expectDelaunay(points: readonly Vec3[], real: number, label: string): void {
  const { tets } = triangulate(points, real);
  expect(
    tets.map((tet) => [...tet.v]),
    `${label}: equals the exact scan`,
  ).toEqual(referenceTriangulation(points, real));
  const faces = new Map<number, number>();
  for (const tet of tets)
    for (const f of facesOf(tet.v)) {
      const key = faceKey(f[0], f[1], f[2], points.length);
      faces.set(key, (faces.get(key) ?? 0) + 1);
    }
  expect(Math.max(...faces.values()), `${label}: a face has more than two tetrahedra`).toBeLessThanOrEqual(2);
  let volume = 0;
  for (const tet of tets) {
    const corners = tet.v.map((n) => points[n] as Vec3) as Corners;
    const side = orient3d(...corners);
    expect(side, `${label}: a flat tetrahedron`).not.toBe(0);
    for (let n = 0; n < points.length; n += 1)
      if (!tet.v.includes(n) && inSphere(...corners, points[n] as Vec3, side) > 0)
        throw new Error(`${label}: point ${n} is inside the circumsphere of ${tet.v.join(',')}`);
    volume += volumeOf(corners);
  }
  const outer = volumeOf([real, real + 1, real + 2, real + 3].map((n) => points[n] as Vec3) as Corners);
  expect(Math.abs(volume - outer) / outer, `${label}: the tetrahedra tile the enclosure`).toBeLessThan(1e-6);
}

describe('exact predicates', () => {
  it('orient3d and inSphere agree with the geometry and are exact on cospherical points', () => {
    const [a, b, c, d] = [
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
      [-5, 0, 0],
    ] as [Vec3, Vec3, Vec3, Vec3];
    const side = orient3d(a, b, c, d);
    expect(side).not.toBe(0);
    expect(inSphere(a, b, c, d, [0, 0, 0], side)).toBe(1);
    expect(inSphere(a, b, c, d, [9, 9, 9], side)).toBe(-1);
    expect(inSphere(a, b, c, d, [3, 4, 0], side)).toBe(0);
    expect(inSphere(a, b, c, d, [0, -3, 4], side)).toBe(0);
    expect(inSphere(a, b, c, d, [3, 4, 1e-300], side)).not.toBe(0);
    expect(orient3d([0, 0, 0], [1, 0, 0], [0, 1, 0], [1e-300, 1e-300, 0])).toBe(0);
    expect(orient3d([0, 0, 0], [1, 0, 0], [0, 1, 0], [0.3, 0.3, 1e-300])).not.toBe(0);
  });
});

describe('delaunay (exact walk + flood Bowyer-Watson)', () => {
  it.each([
    [60, 1],
    [150, 9],
    [150, 36],
    [300, 7],
  ])('%i uniform seeds (seed %i) give a Delaunay triangulation equal to the exact scan', (count, seed) => {
    const random = mulberry32(seed);
    const points = Array.from({ length: count }, (): Vec3 => [random() * 20, random() * 20, random() * 20]);
    expectDelaunay(withEnclosure(points, 20), count, `uniform ${count} seed ${seed}`);
  });

  it('the 1500 seeds on which the tolerance rule of the quadratic scan broke (a sliver sphere held later seeds) equal the exact scan', () => {
    const random = mulberry32(9);
    const points = Array.from({ length: 1500 }, (): Vec3 => [random() * 24, random() * 24, random() * 24]);
    const all = withEnclosure(points, 24);
    expect(triangulate(all, 1500).tets.map((tet) => [...tet.v])).toEqual(referenceTriangulation(all, 1500));
  }, 300_000);

  it.each([1e-9, 1e-11, 1e-13, 0])('a 5 x 5 x 5 lattice jittered by %s (near cospherical, exactly cospherical at 0)', (jitter) => {
    const random = mulberry32(5);
    const points: Vec3[] = [];
    for (let i = 0; i < 5; i += 1)
      for (let j = 0; j < 5; j += 1)
        for (let k = 0; k < 5; k += 1)
          points.push([i + (random() - 0.5) * jitter, j + (random() - 0.5) * jitter, k + (random() - 0.5) * jitter]);
    expectDelaunay(withEnclosure(points, 4), points.length, `lattice ${jitter}`);
  });

  it('points on a sphere to 1e-12 (every four are nearly cospherical)', () => {
    const random = mulberry32(21);
    const points = Array.from({ length: 70 }, (): Vec3 => {
      const [u, v] = [random() * 2 - 1, random() * 2 * Math.PI];
      const s = Math.sqrt(1 - u * u);
      const r = 5 * (1 + (random() - 0.5) * 1e-12);
      return [5 + r * s * Math.cos(v), 5 + r * s * Math.sin(v), 5 + r * u];
    });
    expectDelaunay(withEnclosure(points, 10), points.length, 'sphere');
  });

  it('duplicate seeds are skipped by name (reported in skipped) and the rest is Delaunay', () => {
    const random = mulberry32(3);
    const base = Array.from({ length: 40 }, (): Vec3 => [random() * 10, random() * 10, random() * 10]);
    const points = [...base, base[3] as Vec3, base[10] as Vec3, base[3] as Vec3];
    const all = withEnclosure(points, 10);
    expect(delaunay(all, points.length).skipped).toEqual([40, 41, 42]);
    expectDelaunay(all, points.length, 'duplicates');
  });

  it('coplanar layers (every seed of a layer in one exact plane)', () => {
    const random = mulberry32(8);
    const points: Vec3[] = [];
    for (let layer = 0; layer < 4; layer += 1) for (let n = 0; n < 12; n += 1) points.push([random() * 8, random() * 8, layer * 2]);
    expectDelaunay(withEnclosure(points, 8), points.length, 'layers');
  });
});

describe('typed-array Delaunay (14.16): the same list as the exact scan, at a scale the scan cannot reach', () => {
  const pack = (points: readonly Vec3[]): Float64Array => Float64Array.from(points.flat());

  it('the indexed predicates give the sign of the exact ones on random, near-cospherical, cospherical and 1e-300-off configurations', () => {
    const random = mulberry32(31);
    const cases: Vec3[][] = [];
    for (let n = 0; n < 400; n += 1) cases.push(Array.from({ length: 5 }, (): Vec3 => [random() * 10, random() * 10, random() * 10]));
    for (let n = 0; n < 80; n += 1) {
      // five points on one sphere (exactly cospherical when the offset is 0), four on one plane
      const spot = (): Vec3 => {
        const [u, v] = [random() * 2 - 1, random() * 2 * Math.PI];
        const s = Math.sqrt(1 - u * u);
        const offset = n % 2 === 0 ? 0 : 1e-300;
        return [5 + 5 * s * Math.cos(v) + offset, 5 + 5 * s * Math.sin(v), 5 + 5 * u];
      };
      cases.push(Array.from({ length: 5 }, spot));
      cases.push([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, n % 2 === 0 ? 0 : 1e-300],
        [0.5, 0.5, 1e-9 * n],
      ]);
    }
    for (const [a, b, c, d, e] of cases as [Vec3, Vec3, Vec3, Vec3, Vec3][]) {
      const packed = pack([a, b, c, d, e]);
      expect(orient3dIndexed(packed, 0, 1, 2, 3)).toBe(orient3d(a, b, c, d));
      const side = orient3d(a, b, c, d) || 1;
      expect(inSphereIndexed(packed, 0, 1, 2, 3, 4, side)).toBe(inSphere(a, b, c, d, e, side));
    }
  });

  it('2500 uniform seeds give exactly the tetrahedra, vertex order and circumcentres of the scan over every tetrahedron', () => {
    const random = mulberry32(17);
    const points = Array.from({ length: 2500 }, (): Vec3 => [random() * 30, random() * 30, random() * 30]);
    const all = withEnclosure(points, 30);
    expect(triangulate(all, 2500).tets.map((tet) => [...tet.v])).toEqual(referenceTriangulation(all, 2500));
  }, 600_000);

  it('100000 seeds triangulate in a few seconds, deterministically, and the tetrahedra tile the enclosing tetrahedron', () => {
    const random = mulberry32(7);
    const extent = Math.cbrt(100_000 / 0.04);
    const points = Array.from({ length: 100_000 }, (): Vec3 => [random() * extent, random() * extent, random() * extent]);
    const all = withEnclosure(points, extent);
    const started = performance.now();
    const first = triangulate(all, 100_000);
    const seconds = (performance.now() - started) / 1000;
    expect(seconds).toBeLessThan(30);
    expect(first.skipped).toEqual([]);
    const enclosing = volumeOf([all[100_000], all[100_001], all[100_002], all[100_003]] as Corners);
    const total = first.tets.reduce((sum, tet) => sum + volumeOf(tet.v.map((n) => all[n]) as Corners), 0);
    expect(Math.abs(total - enclosing) / enclosing).toBeLessThan(1e-6);
    const second = triangulate(all, 100_000);
    expect(second.tets.length).toBe(first.tets.length);
    expect(second.tets.every((tet, i) => tet.v.every((n, k) => n === first.tets[i]?.v[k]))).toBe(true);
  }, 120_000);
});
