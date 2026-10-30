/** 04 DIR §5.8, TECHNICAL_SPEC DES-4c exact G1: the linear tangent-plane conditions across the edges of the patches around extraordinary vertices. */

import { describe, expect, it } from 'vitest';
import { type Cage, boxCage, cylinderCage, subdivide } from '@core/geometry/subdivision';
import { solveExactG1 } from '@core/geometry/subd/g1Exact';
import { MEASURE_STATIONS, patchNormal } from '@core/geometry/subd/g1Fit';
import { cageToNurbs } from '@core/geometry/subd/toNurbs';
import { buildTopology } from '@core/geometry/subd/topology';
import { type BezierPatch, quadCagePatches } from '@core/geometry/subdivisionPatches';
import type { Vec3 } from '@core/model/types';

const INTERIOR = new Set([5, 6, 9, 10]);
const CORNERS = new Set([0, 3, 12, 15]);
const valenceOf = (cage: Cage): number[] => {
  const topology = buildTopology(cage.vertices.length, cage.faces);
  return topology.vertexEdges.map((edges, v) => (edges.length === (topology.vertexFaces[v] as number[]).length ? edges.length : 4));
};
const side = (k: number, t: number): [number, number] => (k === 0 ? [t, 0] : k === 1 ? [1, t] : k === 2 ? [1 - t, 1] : [0, 1 - t]);
const bernstein = (t: number): number[] => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
function point(patch: BezierPatch, u: number, v: number): Vec3 {
  const [bu, bv] = [bernstein(u), bernstein(v)];
  const sum = [0, 0, 0];
  patch.forEach((p, idx) => {
    const w = (bu[Math.floor(idx / 4)] as number) * (bv[idx % 4] as number);
    for (let axis = 0; axis < 3; axis++) sum[axis] = (sum[axis] as number) + w * (p[axis] as number);
  });
  return [sum[0] as number, sum[1] as number, sum[2] as number];
}

/** Largest normal angle (radians, analytic normals: no differencing noise) at the measure stations over every edge between two quads. */
function worstBreak(cage: Cage, patches: readonly BezierPatch[]): number {
  const topology = buildTopology(cage.vertices.length, cage.faces);
  let worst = 0;
  for (const edge of topology.edges) {
    if (edge.faces.length !== 2) continue;
    const [f, g] = edge.faces as [number, number];
    const [from, to] = topology.directed.get(`${edge.a}>${edge.b}`) === f ? [edge.a, edge.b] : [edge.b, edge.a];
    const kf = (cage.faces[f] as number[]).indexOf(from);
    const kg = (cage.faces[g] as number[]).indexOf(to);
    for (const t of MEASURE_STATIONS) {
      const first = patchNormal(patches[f] as BezierPatch, ...side(kf, t));
      const second = patchNormal(patches[g] as BezierPatch, ...side(kg, 1 - t));
      const cosine = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
      worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, cosine))));
    }
  }
  return worst;
}

const hexahedra: Array<[string, Cage]> = (() => {
  const base = boxCage([2, 2, 2], [1, 1, 1]);
  const warp = (map: (v: Vec3, i: number) => Vec3): Cage => ({ ...base, vertices: base.vertices.map(map) });
  return [
    ['cube', base],
    ['sheared cube', warp((v): Vec3 => [v[0] + 0.3 * v[2], v[1], v[2]])],
    ['cube with one corner pulled out', warp((v, i): Vec3 => (i === 0 ? [v[0] - 0.2, v[1] - 0.2, v[2] - 0.2] : v))],
  ];
})();

/** A pentagonal cap: a valence-5 vertex and valence-3 vertices around it. */
function pentagonCap(): Cage {
  const ring = (z: number): Vec3[] =>
    Array.from({ length: 5 }, (_, i): Vec3 => [Math.cos((2 * Math.PI * i) / 5), Math.sin((2 * Math.PI * i) / 5), z]);
  const mid = Array.from(
    { length: 5 },
    (_, i): Vec3 => [0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / 5), 0.5 * Math.sin((2 * Math.PI * (i + 0.5)) / 5), 1.2],
  );
  const vertices: Vec3[] = [...ring(1), ...mid, [0, 0, 1.4], ...ring(-1)];
  const faces: number[][] = [];
  for (let i = 0; i < 5; i++) faces.push([10, 5 + ((i + 4) % 5), i, 5 + i].reverse());
  for (let i = 0; i < 5; i++) faces.push([i, (i + 1) % 5, 11 + ((i + 1) % 5), 11 + i].reverse());
  faces.push([11, 12, 13, 14, 15].reverse());
  return { vertices, faces, creases: [] };
}

/** Two quads sharing the edge x = 1 (vertices 0 and 4 stand for extraordinary ones so that both are free): P on [0, 1] x [0, 1], Q on [1, 3] x [0, 1], planar. */
const pairCage: Cage = {
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [3, 0, 0],
    [3, 1, 0],
  ],
  faces: [
    [0, 1, 2, 3],
    [1, 4, 5, 2],
  ],
  creases: [],
};
const pairValence = [3, 4, 4, 4, 3, 4];
/** Bicubic grid x = x0 + width * i / 3 (+ `lean(j)` on the row next to the edge), y = j / 3, z = 0, pole (i, j) at i * 4 + j. */
const grid = (x0: number, width: number, lean: (j: number) => number = () => 0): BezierPatch =>
  Array.from({ length: 16 }, (_, k): Vec3 => {
    const [i, j] = [Math.floor(k / 4), k % 4];
    return [x0 + (width * i) / 3 + (i === 1 ? lean(j) : 0), j / 3, 0];
  });

describe('solveExactG1', () => {
  for (const [name, cage] of hexahedra) {
    it(`${name}: stage 1 (only interior poles) makes every edge of the 24 corner quads G1 to 1e-7 rad (the plain patches break by 0.04), boundary poles bit-identical`, () => {
      const refined = subdivide(cage, 1);
      const patches = quadCagePatches(refined);
      const result = solveExactG1(refined, patches, valenceOf(refined));
      expect(result.method).toBe('boundary-kept');
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toMatchObject({ quads: 24, valences: [3], consistent: true });
      expect(result.groups[0]?.residual).toBeLessThan(1e-12);
      expect(result.groups[0]?.endMisfit).toBeLessThan(1e-12);
      expect(worstBreak(refined, patches)).toBeGreaterThan(0.04);
      expect(worstBreak(refined, result.patches)).toBeLessThan(1e-7);
      let moved = 0;
      patches.forEach((patch, f) =>
        patch.forEach((p, k) => {
          const same = (result.patches[f] as Vec3[])[k]?.every((value, axis) => value === p[axis]);
          if (!INTERIOR.has(k)) expect(same, `patch ${f} pole ${k}`).toBe(true);
          else if (!same) moved++;
        }),
      );
      expect(moved).toBeGreaterThan(48);
    });
  }

  for (const [name, cage, quads] of [
    ['box 2 x 2 x 2', boxCage([2, 2, 2], [2, 2, 2]), 96],
    ['box 3 x 2 x 1', boxCage([3, 2, 1], [3, 2, 1]), 88],
    ['cylinder of 8 sides', cylinderCage(1, 2, 8, 2), 80],
    ['cylinder of 5 sides', cylinderCage(1, 2, 5, 2), 50],
  ] as const) {
    it(`${name}: the interior poles alone have no solution (a valence-4 vertex beside one extraordinary vertex); freeing the inner edge poles makes it G1 to 1e-7 rad with the same ${quads} patches and the same corner poles`, () => {
      const refined = subdivide(cage, 1);
      const patches = quadCagePatches(refined);
      expect(patches).toHaveLength(quads);
      const result = solveExactG1(refined, patches, valenceOf(refined));
      expect(result.method).toBe('edges-freed');
      expect(result.groups.length).toBeGreaterThan(0);
      expect(result.groups.every((group) => group.consistent && group.residual < 1e-12)).toBe(true);
      expect(result.patches).toHaveLength(quads);
      expect(worstBreak(refined, result.patches)).toBeLessThan(1e-7);
      // corner poles (the vertices of the refined cage) never move; some inner edge poles do; both patches of an edge keep one common boundary curve (G0)
      let edgePolesMoved = 0;
      patches.forEach((patch, f) =>
        patch.forEach((p, k) => {
          const same = (result.patches[f] as Vec3[])[k]?.every((value, axis) => value === p[axis]);
          if (CORNERS.has(k)) expect(same, `patch ${f} corner ${k}`).toBe(true);
          else if (!INTERIOR.has(k) && !same) edgePolesMoved++;
        }),
      );
      expect(edgePolesMoved).toBeGreaterThan(0);
      const topology = buildTopology(refined.vertices.length, refined.faces);
      for (const edge of topology.edges) {
        const [f, g] = edge.faces as [number, number];
        const [from, to] = topology.directed.get(`${edge.a}>${edge.b}`) === f ? [edge.a, edge.b] : [edge.b, edge.a];
        const kf = (refined.faces[f] as number[]).indexOf(from);
        const kg = (refined.faces[g] as number[]).indexOf(to);
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          const first = point(result.patches[f] as BezierPatch, ...side(kf, t));
          const second = point(result.patches[g] as BezierPatch, ...side(kg, 1 - t));
          expect(Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2])).toBeLessThan(1e-12);
        }
      }
    });
  }

  it('a cylinder of 24 sides (valence-24 cap stars, one group of 240 quads and over 900 unknown poles: the conjugate-gradient path, no limit-surface objective) is exact too', () => {
    const refined = subdivide(cylinderCage(1, 2, 24, 2), 1);
    const patches = quadCagePatches(refined);
    const result = solveExactG1(refined, patches, valenceOf(refined));
    expect(result.method).toBe('edges-freed');
    expect(result.groups).toEqual([expect.objectContaining({ quads: 240, consistent: true })]);
    expect(worstBreak(refined, patches)).toBeGreaterThan(0.5);
    expect(worstBreak(refined, result.patches)).toBeLessThan(1e-7);
  }, 60_000);

  it('a star the solve cannot make G1 (a pentagonal cap) is reported with the residual of its groups and left as given', () => {
    const cap = subdivide(pentagonCap(), 1);
    const patches = quadCagePatches(cap);
    const result = solveExactG1(cap, patches, valenceOf(cap));
    expect(result.groups.some((group) => !group.consistent && group.residual > 1e-3)).toBe(true);
    expect(JSON.stringify(result.patches)).toBe(JSON.stringify(patches));
  });

  it('closed form: two flat patches whose cross derivatives differ by a factor 2 across their edge (a = 2, beta = 0) already satisfy the conditions and are not moved; a tilted pair is moved until it is G1 to 1e-7 rad', () => {
    const patches = [grid(0, 1), grid(1, 2)];
    const result = solveExactG1(pairCage, patches, pairValence);
    expect(result.groups).toEqual([expect.objectContaining({ quads: 2, consistent: true })]);
    // the pair is G1 to start with and stays so (the solution set holds other poles than the start ones too: the limit-surface objective picks among them)
    expect(worstBreak(pairCage, patches)).toBeLessThan(1e-12);
    expect(worstBreak(pairCage, result.patches)).toBeLessThan(1e-7);
    const tilted = patches.map((patch, f) => patch.map((p, k): Vec3 => (f === 1 && k === 5 ? [p[0], p[1], 0.4] : p)));
    expect(worstBreak(pairCage, tilted)).toBeGreaterThan(0.1);
    const fixed = solveExactG1(pairCage, tilted, pairValence);
    expect(fixed.groups[0]?.consistent).toBe(true);
    expect(((fixed.patches[1] as Vec3[])[5] as Vec3)[2]).not.toBe(0.4);
    expect(worstBreak(pairCage, fixed.patches)).toBeLessThan(1e-7);
  });

  it('an edge whose two ends need different factors a (one constant a cannot meet both end conditions) is refused with its end misfit, not fitted across', () => {
    // the row of poles next to the edge leans so that the cross derivative is 1 at one end and 2 at the other
    const lean = (j: number): number => -(j / 3) / 3;
    const patches = [grid(0, 1), grid(1, 2, lean)];
    const result = solveExactG1(pairCage, patches, pairValence);
    expect(result.groups).toEqual([expect.objectContaining({ consistent: false })]);
    expect(result.groups[0]?.endMisfit).toBeGreaterThan(1e-3);
    expect(JSON.stringify(result.patches)).toBe(JSON.stringify(patches));
  });

  it('an edge without an end fit (a boundary collapsed to a point: no tangent) makes its group inconsistent with an infinite residual, never silently skipped', () => {
    const collapsed = grid(0, 1).map((p, k): Vec3 => (Math.floor(k / 4) === 3 ? [1, 0.5, 0] : p));
    const other = grid(1, 2).map((p, k): Vec3 => (Math.floor(k / 4) === 0 ? [1, 0.5, 0] : p));
    const result = solveExactG1(pairCage, [collapsed, other], pairValence);
    expect(result.groups[0]).toMatchObject({ consistent: false, residual: Infinity });
  });

  it('a cage with no extraordinary vertex has nothing to solve; the input is not changed', () => {
    const regular = subdivide(boxCage([4, 4, 1], [4, 4, 1]), 1);
    const patches = quadCagePatches(regular);
    const before = JSON.stringify(patches);
    const result = solveExactG1(
      regular,
      patches,
      valenceOf(regular).map(() => 4),
    );
    expect(result.groups).toEqual([]);
    expect(result.method).toBeNull();
    expect(JSON.stringify(result.patches)).toBe(before);
    expect(JSON.stringify(patches)).toBe(before);
  });
});

describe('cageToNurbs with fitTangents: exact where it exists, the fit otherwise', () => {
  it('a cube is exact (data g1Method "exact", the analytic break below 1e-5 degree), keeps the patch count and its position cost stays within 3.5x of the plain patches', () => {
    const plain = cageToNurbs(boxCage([2, 2, 2], [1, 1, 1]), { packed: false, samples: 4 });
    const exact = cageToNurbs(boxCage([2, 2, 2], [1, 1, 1]), { packed: false, samples: 4, fitTangents: true });
    expect(exact).toMatchObject({ g1Method: 'exact', exactMethod: 'boundary-kept', exactFreeQuads: 24, patchCount: plain.patchCount });
    expect(exact.exactRefused).toEqual([]);
    expect(plain.maxEvG1Deg).toBeGreaterThan(2.5);
    expect(exact.maxEvG1Deg).toBeLessThan(1e-5);
    expect(exact.maxEvG0).toBe(0);
    expect(exact.maxDeviation).toBeLessThanOrEqual(3.5 * plain.maxDeviation);
  });

  it('a box 2 x 2 x 2 and a cylinder are exact with the inner edge poles freed (no group refused), the same patch count, a gap of 0', () => {
    for (const [cage, bound] of [
      [boxCage([2, 2, 2], [2, 2, 2]), 13],
      [cylinderCage(1, 2, 8, 2), 1.5],
    ] as const) {
      const plain = cageToNurbs(cage, { packed: false, samples: 4 });
      const result = cageToNurbs(cage, { packed: false, samples: 4, fitTangents: true });
      expect(result).toMatchObject({ g1Method: 'exact', exactMethod: 'edges-freed', patchCount: plain.patchCount, exactRefused: [] });
      expect(result.exactFreeQuads).toBeGreaterThan(0);
      expect(result.maxEvG1Deg).toBeLessThan(1e-5);
      expect(result.maxEvG0).toBeLessThan(1e-12);
      // the position cost, bounded: the limit-surface objective keeps the box at 11x the plain deviation (17x without it), the cylinder near 1.2x
      expect(result.maxDeviation).toBeLessThanOrEqual(bound * plain.maxDeviation);
    }
  });

  it('a star the exact solve refuses falls back to the tangent-plane fit and lists the groups', () => {
    const result = cageToNurbs(pentagonCap(), { packed: false, samples: 4, fitTangents: true });
    expect(result.g1Method).toBe('fit');
    expect(result.exactMethod).toBeNull();
    expect(result.exactRefused.length).toBeGreaterThan(0);
    expect(result.maxEvG1Deg).toBeLessThan(1);
  });

  it('exactG1 false forces the fit; without a G1 request there is no method', () => {
    const cube = boxCage([2, 2, 2], [1, 1, 1]);
    expect(cageToNurbs(cube, { packed: false, samples: 4, fitTangents: true, exactG1: false })).toMatchObject({
      g1Method: 'fit',
      exactRefused: [],
    });
    expect(cageToNurbs(cube, { packed: false, samples: 4 }).g1Method).toBeNull();
  });
});
