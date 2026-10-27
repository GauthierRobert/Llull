/** 07 MSH M6: the limit operator of the cage fit (`subd/fitOperator`): its rows against `cageVertexLimits`, level independence with semi-sharp creases and boundaries, and the nearest-vertex grid. */

import { describe, expect, it } from 'vitest';
import { applyOperator, buildFitOperator, limitSurfaceMesh, sampleLevel } from '@core/geometry/subd/fitOperator';
import { cageVertexLimits, fanOf, prepare } from '@core/geometry/subd/limit';
import { fullSettleLevels, settleLevels, settledCage } from '@core/geometry/subd/settle';
import { VertexGrid } from '@core/geometry/mesh/vertexGrid';
import { dartMaskWeights } from '@core/geometry/subd/dartMask';
import { boxCage, cageProblem, subdivide, type Cage } from '@core/geometry/subdivision';
import type { Vec3 } from '@core/model/types';

/** Limit points the operator gives at the cage vertices (its first rows). */
function operatorPoints(cage: Cage, level: number): Vec3[] {
  const op = buildFitOperator(cage, level);
  const axes = [0, 1, 2].map((a) => {
    const out = new Float64Array(op.rows);
    applyOperator(
      op,
      Float64Array.from(cage.vertices, (p) => p[a] as number),
      out,
    );
    return out;
  });
  return cage.vertices.map((_, v) => [
    (axes[0] as Float64Array)[v] as number,
    (axes[1] as Float64Array)[v] as number,
    (axes[2] as Float64Array)[v] as number,
  ]);
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A lumpy cube cage (so that nothing is symmetric by accident) with the given sharpness data. */
function cube(extra: Partial<Cage>): Cage {
  const base = boxCage([4, 4, 4], [2, 2, 2]);
  const vertices = base.vertices.map(
    (p, i): Vec3 => [p[0] + 0.1 * Math.sin(i), p[1] + 0.1 * Math.cos(2 * i), p[2] + 0.1 * Math.sin(3 * i)],
  );
  return { ...base, vertices, ...extra };
}

/** An open 4 x 4 grid cage with a bump. */
function patch(boundary: 'edge_only' | 'edge_and_corner'): Cage {
  const n = 4;
  const vertices: Vec3[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push([i, j, Math.sin(i + 2 * j) * 0.3]);
  const faces: number[][] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) faces.push([j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i]);
  return { vertices, faces, creases: [], boundary };
}

/** The equator ring of the cube cage as infinite creases (a closed loop: no dart vertices, whose smooth mask is only approximate). */
const equator = (): Array<[number, number]> => {
  const base = boxCage([4, 4, 4], [2, 2, 2]);
  const ring = new Map<string, [number, number]>();
  for (const face of base.faces)
    face.forEach((a, k) => {
      const b = face[(k + 1) % face.length] as number;
      if (Math.abs((base.vertices[a] as Vec3)[2]) < 1e-9 && Math.abs((base.vertices[b] as Vec3)[2]) < 1e-9)
        ring.set(`${Math.min(a, b)}-${Math.max(a, b)}`, [a, b]);
    });
  return [...ring.values()];
};

const CASES: Array<[string, Cage]> = [
  ['smooth cube', cube({})],
  ['infinite creases (equator loop)', cube({ creases: equator() })],
  [
    'uniform semi-sharp 2.5',
    cube({
      edgeSharpness: [
        { a: 0, b: 1, s: 2.5 },
        { a: 1, b: 2, s: 1.2 },
      ],
      creaseMethod: 'uniform',
    }),
  ],
  [
    'chaikin semi-sharp 3',
    cube({
      edgeSharpness: [
        { a: 0, b: 1, s: 3 },
        { a: 1, b: 2, s: 1.7 },
      ],
      creaseMethod: 'chaikin',
    }),
  ],
  ['sharp vertex', cube({ vertexSharpness: [{ v: 3, s: 2 }] })],
  ['open patch, edge_and_corner', patch('edge_and_corner')],
  ['open patch, edge_only', patch('edge_only')],
];

describe('fit operator', () => {
  for (const [name, cage] of CASES) {
    it(`${name}: valid cage; rows at the cage vertices equal cageVertexLimits at levels 1..3 and agree with a deeper level`, () => {
      expect(cageProblem(cage)).toBeNull();
      const exact = cageVertexLimits(
        cage,
        cage.vertices.map((_, v) => v),
      ).map((limit) => limit.point);
      const deep = operatorPoints(cage, 4);
      for (const level of [1, 2, 3]) {
        const points = operatorPoints(cage, level);
        points.forEach((p, v) => {
          expect(distance(p, exact[v] as Vec3), `${name} level ${level} vertex ${v} against cageVertexLimits`).toBeLessThan(1e-12);
          expect(distance(p, deep[v] as Vec3), `${name} level ${level} vertex ${v} against level 4`).toBeLessThan(1e-9);
        });
      }
    });
  }

  it('refines to the settle level whatever level is asked, in the operator and in the point-wise limit mesh', () => {
    const cage = cube({ edgeSharpness: [{ a: 0, b: 1, s: 2.5 }] });
    expect(settleLevels(cage)).toBe(3);
    expect(sampleLevel(cage, 1)).toBe(3);
    expect(sampleLevel(cage, 4)).toBe(4);
    expect(sampleLevel(cube({}), 0)).toBe(1);
    expect(buildFitOperator(cage, 1).rows).toBe(buildFitOperator(cage, 3).rows);
    expect(limitSurfaceMesh(cage, 1).mesh.positions).toEqual(limitSurfaceMesh(cage, 3).mesh.positions);
    expect(limitSurfaceMesh(cage, 1).level).toBe(3);
    expect(limitSurfaceMesh(cage, 4).level).toBe(4);
    // the limit point of vertex 0 does not depend on the asked level (the old level-1 mask was off by about 0.09 here)
    expect(distance(operatorPoints(cage, 1)[0] as Vec3, operatorPoints(cage, 3)[0] as Vec3)).toBeLessThan(1e-12);
  });
});

describe('VertexGrid', () => {
  it('finds the exact nearest vertex (ties to the lower index), also far outside the cloud, and respects the index subset', () => {
    let seed = 7;
    const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 10;
    const positions = Array.from({ length: 3 * 400 }, random);
    const grid = new VertexGrid(positions);
    const brute = (p: Vec3, among: ReadonlyArray<number>): number => {
      let [best, bestSq] = [-1, Infinity];
      for (const v of among) {
        const dSq =
          ((positions[3 * v] as number) - p[0]) ** 2 +
          ((positions[3 * v + 1] as number) - p[1]) ** 2 +
          ((positions[3 * v + 2] as number) - p[2]) ** 2;
        if (dSq < bestSq) [best, bestSq] = [v, dSq];
      }
      return best;
    };
    const all = Array.from({ length: 400 }, (_, v) => v);
    for (const p of [
      [5, 5, 5],
      [0, 0, 0],
      [-30, 4, 90],
      [12, 12, 12],
    ] as Vec3[])
      expect(grid.nearest(p).index).toBe(brute(p, all));
    for (let i = 0; i < 50; i++) {
      const p: Vec3 = [random() - 2, random() - 2, random() - 2];
      expect(grid.nearest(p).index).toBe(brute(p, all));
    }
    const subset = all.filter((v) => v % 3 === 0);
    const partial = new VertexGrid(positions, subset);
    expect(partial.nearest([1, 2, 3]).index).toBe(brute([1, 2, 3], subset));
    const twin = new VertexGrid([1, 1, 1, 1, 1, 1]);
    expect(twin.nearest([0, 0, 0])).toMatchObject({ index: 0 });
    expect(new VertexGrid([]).nearest([0, 0, 0])).toEqual({ index: -1, distance: Infinity });
  });
});

/** A fan of n quads around vertex 0 (face j is [0, e_j, d_j, e_{j-1}]) with the edge to e_sharp infinitely sharp: vertex 0 is a dart. */
function dartFan(n: number, sharp: number): Cage {
  const vertices: Vec3[] = [[0.1, -0.05, 0.2]];
  for (let i = 0; i < n; i++)
    vertices.push([Math.cos((2 * Math.PI * i) / n) * (1 + 0.1 * i), Math.sin((2 * Math.PI * i) / n), 0.3 * Math.sin(2 * i)]);
  for (let i = 0; i < n; i++)
    vertices.push([2 * Math.cos((2 * Math.PI * (i - 0.5)) / n), 2 * Math.sin((2 * Math.PI * (i - 0.5)) / n) + 0.2 * i, 0.5 * Math.cos(i)]);
  const faces = Array.from({ length: n }, (_, j) => [0, 1 + ((j + n - 1) % n), 1 + n + j, 1 + j]);
  return { vertices, faces, creases: [[0, 1 + sharp]] };
}

/** A vertex from its three coordinates, typed (no casts). */
const tuple = (coordinate: (axis: number) => number): Vec3 => [coordinate(0), coordinate(1), coordinate(2)];

/** The weighted sum of `cage.vertices` (weights in the order 0, e_0.., d_0..). */
const weighted = (cage: Cage, weights: ReadonlyArray<number>): Vec3 =>
  tuple((a) => cage.vertices.reduce((total, p, i) => total + (p[a] as number) * (weights[i] as number), 0));

describe('dart limit mask', () => {
  it('without a sharp edge the eigenvector mask is the Halstead mask', () => {
    for (const n of [3, 4, 5, 8]) {
      const mask = dartMaskWeights(n, -1);
      const norm = n * (n + 5);
      expect(mask[0]).toBeCloseTo((n * n) / norm, 12);
      for (let i = 1; i <= n; i++) expect(mask[i]).toBeCloseTo(4 / norm, 12);
      for (let i = n + 1; i <= 2 * n; i++) expect(mask[i]).toBeCloseTo(1 / norm, 12);
    }
  });

  it('is the limit of the real refinement: the error of the vertex after k levels falls by a constant factor, where the smooth mask stays off', () => {
    for (const n of [3, 4, 5]) {
      const cage = dartFan(n, 1 % n);
      const at = (weights: ReadonlyArray<number>): Vec3 => weighted(cage, weights);
      const exact = at(dartMaskWeights(n, 1 % n));
      const smooth = at(dartMaskWeights(n, -1));
      expect(exact.every(Number.isFinite)).toBe(true);
      const errors = [4, 5, 6, 7, 8].map((k) => distance(subdivide(cage, k).vertices[0] as Vec3, exact));
      for (let k = 1; k < errors.length; k++) expect((errors[k] as number) / (errors[k - 1] as number)).toBeLessThan(0.6);
      expect(errors[4] as number).toBeLessThan(1e-3);
      // Aitken extrapolation of the last three levels agrees with the mask much better than the last level does
      const seq = [6, 7, 8].map((k) => subdivide(cage, k).vertices[0] as Vec3);
      const aitken = tuple((a) => {
        const [x0, x1, x2] = seq.map((point) => point[a] as number) as [number, number, number];
        return x2 - (x2 - x1) ** 2 / (x2 - x1 - (x1 - x0));
      });
      expect(distance(aitken, exact)).toBeLessThan(2e-4);
      expect(distance(aitken, exact)).toBeLessThan(errors[4] as number);
      // the smooth mask misses the true limit by far more than the exact mask does
      expect(distance(smooth, exact)).toBeGreaterThan(1e-3);
      expect(distance(aitken, smooth)).toBeGreaterThan(10 * distance(aitken, exact));
    }
  });

  it('is invariant under refinement: the mask on the level-0, level-1 and level-2 rings of the real subdivide agrees to 1e-13, n = 3..12, three sharp positions', () => {
    let worst = 0;
    for (let n = 3; n <= 12; n++)
      for (const sharp of [0, 1 % n, n - 1]) {
        const level0 = dartFan(n, sharp);
        // the ring of vertex 0 at a level: the fan order of `fanOf` and the index of the child of the sharp crease that ends at vertex 0
        const limitAt = (cage: Cage): Vec3 => {
          const crease = cage.creases.find(([a, b]) => a === 0 || b === 0) as readonly [number, number];
          const { e, d } = fanOf(prepare(cage), 0);
          const mask = dartMaskWeights(e.length, e.indexOf(crease[0] === 0 ? crease[1] : crease[0]));
          return tuple((a) => [0, ...e, ...d].reduce((total, v, k) => total + (cage.vertices[v]?.[a] as number) * (mask[k] as number), 0));
        };
        const [a, b, c] = [level0, subdivide(level0, 1), subdivide(level0, 2)].map(limitAt) as [Vec3, Vec3, Vec3];
        worst = Math.max(worst, distance(a, b), distance(a, c));
      }
    expect(worst).toBeLessThan(1e-13);
  });
});

describe('sharpness above three', () => {
  const cage = (): Cage => cube({ edgeSharpness: [{ a: 0, b: 1, s: 5 }] });

  it('settles at ceil(5) = 5 levels, not at the cap of 3, so the operator is the surface refineOnce defines', () => {
    expect(settleLevels(cage())).toBe(3);
    expect(fullSettleLevels(cage())).toBe(5);
    expect(sampleLevel(cage(), 1)).toBe(5);
    expect(limitSurfaceMesh(cage(), 1).level).toBe(5);
    const points = [1, 5, 6, 7].map((level) => operatorPoints(cage(), level));
    // level independence from the settle level on, for every cage vertex
    for (const later of points.slice(1)) later.forEach((p, v) => expect(distance(p, (points[1] as Vec3[])[v] as Vec3)).toBeLessThan(1e-9));
    points[0]?.forEach((p, v) => expect(distance(p, (points[1] as Vec3[])[v] as Vec3)).toBeLessThan(1e-12));
    // and the limit of the real refinement: the vertex after k levels approaches the operator point
    const exact = points[1] as Vec3[];
    for (const v of [0, 1, 4]) {
      const errors = [5, 6, 7].map((k) => distance(subdivide(cage(), k).vertices[v] as Vec3, exact[v] as Vec3));
      expect(errors[2] as number).toBeLessThan(errors[0] as number);
      expect(errors[2] as number).toBeLessThan(0.01);
    }
  });

  it('the capped settling used by the other exact paths stops at 3 levels with the edge still sharp', () => {
    const settled = settledCage(cage());
    expect(settled.levels).toBe(3);
    expect(settled.cage.edgeSharpness?.length).toBeGreaterThan(0);
    expect(Math.max(...(settled.cage.edgeSharpness ?? []).map((e) => e.s))).toBeCloseTo(2, 12);
  });
});
