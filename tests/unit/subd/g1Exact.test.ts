/** 04 DIR §5.8, TECHNICAL_SPEC DES-4c exact G1: the linear tangent-plane conditions across the edges of the patches around extraordinary vertices. */

import { describe, expect, it } from 'vitest';
import { type Cage, boxCage, cylinderCage, subdivide } from '@core/geometry/subdivision';
import { solveExactG1 } from '@core/geometry/subd/g1Exact';
import { MEASURE_STATIONS } from '@core/geometry/subd/g1Fit';
import { cageToNurbs } from '@core/geometry/subd/toNurbs';
import { buildTopology } from '@core/geometry/subd/topology';
import { type BezierPatch, quadCagePatches } from '@core/geometry/subdivisionPatches';
import type { Vec3 } from '@core/model/types';

const INTERIOR = new Set([5, 6, 9, 10]);
const valenceOf = (cage: Cage): number[] => {
  const topology = buildTopology(cage.vertices.length, cage.faces);
  return topology.vertexEdges.map((edges, v) => (edges.length === (topology.vertexFaces[v] as number[]).length ? edges.length : 4));
};

const bernstein = (t: number): number[] => {
  const s = 1 - t;
  return [s * s * s, 3 * t * s * s, 3 * t * t * s, t * t * t];
};
const derivative = (t: number): number[] => {
  const s = 1 - t;
  return [-3 * s * s, 3 * s * s - 6 * t * s, 6 * t * s - 3 * t * t, 3 * t * t];
};
/** Unit normal of `patch` at (u, v) by analytic derivatives: no finite-difference noise, so a 1e-8 rad break is visible. */
function normal(patch: BezierPatch, u: number, v: number): Vec3 {
  const [bu, bv, du, dv] = [bernstein(u), bernstein(v), derivative(u), derivative(v)];
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < 3; k++) {
        a[k] = (a[k] as number) + (du[i] as number) * (bv[j] as number) * ((patch[i * 4 + j] as Vec3)[k] as number);
        b[k] = (b[k] as number) + (bu[i] as number) * (dv[j] as number) * ((patch[i * 4 + j] as Vec3)[k] as number);
      }
  const n = [
    (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number),
    (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number),
    (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number),
  ];
  const length = Math.hypot(...n) || 1;
  return [(n[0] as number) / length, (n[1] as number) / length, (n[2] as number) / length];
}
const side = (k: number, t: number): [number, number] => (k === 0 ? [t, 0] : k === 1 ? [1, t] : k === 2 ? [1 - t, 1] : [0, 1 - t]);

/** Largest normal angle (radians) at the measure stations over every edge between two quads that touches an extraordinary vertex. */
function worstBreak(cage: Cage, patches: readonly BezierPatch[], valence: number[]): number {
  const topology = buildTopology(cage.vertices.length, cage.faces);
  let worst = 0;
  for (const edge of topology.edges) {
    if (edge.faces.length !== 2 || (valence[edge.a] === 4 && valence[edge.b] === 4)) continue;
    const [f, g] = edge.faces as [number, number];
    const [from, to] = topology.directed.get(`${edge.a}>${edge.b}`) === f ? [edge.a, edge.b] : [edge.b, edge.a];
    const kf = (cage.faces[f] as number[]).indexOf(from);
    const kg = (cage.faces[g] as number[]).indexOf(to);
    for (const t of MEASURE_STATIONS) {
      const first = normal(patches[f] as BezierPatch, ...side(kf, t));
      const second = normal(patches[g] as BezierPatch, ...side(kg, 1 - t));
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

describe('solveExactG1', () => {
  for (const [name, cage] of hexahedra) {
    it(`${name}: every edge of the 24 corner quads is G1 to 1e-7 rad (the tangent-plane fit leaves 1e-3), G0 untouched, only interior poles moved`, () => {
      const refined = subdivide(cage, 1);
      const patches = quadCagePatches(refined);
      const valence = valenceOf(refined);
      const result = solveExactG1(refined, patches, valence);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toMatchObject({ quads: 24, valences: [3], consistent: true });
      expect(result.groups[0]?.residual).toBeLessThan(1e-12);
      expect(worstBreak(refined, patches, valence)).toBeGreaterThan(0.04);
      expect(worstBreak(refined, result.patches, valence)).toBeLessThan(1e-7);
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

  it('end conditions: a, beta0, beta1 of every edge fit the fixed poles to rounding (the cross poles at the ends of an edge are tangent-plane consistent)', () => {
    const refined = subdivide(boxCage([2, 2, 2], [1, 1, 1]), 1);
    expect(solveExactG1(refined, quadCagePatches(refined), valenceOf(refined)).endMisfit).toBeLessThan(1e-12);
  });

  it('closed form: two flat patches whose cross derivatives differ by a factor 2 across their edge (a = 2, beta = 0) already satisfy the conditions and are not moved', () => {
    // P on [0, 1] x [0, 1], Q on [1, 3] x [0, 1], uniform poles: the inward derivatives at x = 1 are (-1, 0, 0) and (+2, 0, 0)
    const grid = (x0: number, width: number): BezierPatch =>
      Array.from({ length: 16 }, (_, k): Vec3 => [x0 + (width * Math.floor(k / 4)) / 3, (k % 4) / 3, 0]);
    const cage: Cage = {
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
    const patches = [grid(0, 1), grid(1, 2)];
    // vertices 0 and 4 stand for extraordinary ones so that both quads are free
    const result = solveExactG1(cage, patches, [3, 4, 4, 4, 3, 4]);
    expect(result.groups).toEqual([expect.objectContaining({ quads: 2, consistent: true })]);
    result.patches.forEach((patch, f) =>
      patch.forEach((p, k) =>
        p.forEach((value, axis) =>
          expect(Math.abs(value - ((patches[f] as BezierPatch)[k] as Vec3)[axis]!), `patch ${f} pole ${k}`).toBeLessThan(1e-12),
        ),
      ),
    );
    // and a pair that is NOT G1 across the edge (Q tilted up by its second row) is moved until it is
    const tilted = patches.map((patch, f) => patch.map((p, k): Vec3 => (f === 1 && k === 5 ? [p[0], p[1], 0.4] : p)));
    const fixed = solveExactG1(cage, tilted, [3, 4, 4, 4, 3, 4]);
    expect(fixed.groups[0]?.consistent).toBe(true);
    expect(((fixed.patches[1] as Vec3[])[5] as Vec3)[2]).not.toBe(0.4);
  });

  it('a cage with no extraordinary vertex has nothing to solve; the input is not changed', () => {
    const grid = subdivide(boxCage([4, 4, 1], [4, 4, 1]), 1);
    const patches = quadCagePatches(grid);
    const before = JSON.stringify(patches);
    const result = solveExactG1(
      grid,
      patches,
      valenceOf(grid).map(() => 4),
    );
    expect(result.groups).toEqual([]);
    expect(JSON.stringify(result.patches)).toBe(before);
    expect(JSON.stringify(patches)).toBe(before);
  });

  it('a star whose vertex enclosure has no solution at this degree is reported with its residual and left as given (a box 2 x 2 x 2: a valence-4 vertex beside one corner only)', () => {
    const refined = subdivide(boxCage([2, 2, 2], [2, 2, 2]), 1);
    const patches = quadCagePatches(refined);
    const result = solveExactG1(refined, patches, valenceOf(refined));
    expect(result.groups).toHaveLength(8);
    for (const group of result.groups) expect(group).toMatchObject({ quads: 3, valences: [3], consistent: false });
    expect(result.groups.every((group) => group.residual > 1e-3)).toBe(true);
    expect(JSON.stringify(result.patches)).toBe(JSON.stringify(patches));
  });
});

describe('cageToNurbs with fitTangents: exact where it exists, the fit otherwise', () => {
  it('a cube is exact (data g1Method "exact", break 1e-6 rad at most, the finite-difference noise of the report) and has the same patch count as the plain conversion', () => {
    const plain = cageToNurbs(boxCage([2, 2, 2], [1, 1, 1]), { packed: false, samples: 4 });
    const exact = cageToNurbs(boxCage([2, 2, 2], [1, 1, 1]), { packed: false, samples: 4, fitTangents: true });
    expect(exact.g1Method).toBe('exact');
    expect(exact.exactRefused).toEqual([]);
    expect(exact.patchCount).toBe(plain.patchCount);
    expect(plain.maxEvG1Deg).toBeGreaterThan(2.5);
    expect((exact.maxEvG1Deg * Math.PI) / 180).toBeLessThan(2e-6);
    expect(exact.maxEvG0).toBe(0);
  });

  it('a box 2 x 2 x 2 and a cylinder fall back to the tangent-plane fit and list the groups the exact solve refused', () => {
    for (const cage of [boxCage([2, 2, 2], [2, 2, 2]), cylinderCage(1, 2, 8, 2)]) {
      const result = cageToNurbs(cage, { packed: false, samples: 4, fitTangents: true });
      expect(result.g1Method).toBe('fit');
      expect(result.exactRefused.length).toBeGreaterThan(0);
      expect(result.maxEvG1Deg).toBeLessThan(1);
    }
  });

  it('without a G1 request there is no method', () => {
    expect(cageToNurbs(boxCage([2, 2, 2], [1, 1, 1]), { packed: false, samples: 4 }).g1Method).toBeNull();
  });
});
