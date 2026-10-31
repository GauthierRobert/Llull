/** 04 DIR §5.8, TECHNICAL_SPEC DES-4c: g1Solve "auto" / "exact" / "fit" of subdivision_to_nurbs, the position-cost warning, the bounded exact solve and its named refusals. */

import { describe, expect, it } from 'vitest';
import { type CadDocument, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { type Cage, boxCage, cylinderCage, subdivide } from '@core/geometry/subdivision';
import { solveExactG1 } from '@core/geometry/subd/g1Exact';
import { cageToNurbs } from '@core/geometry/subd/toNurbs';
import { buildTopology } from '@core/geometry/subd/topology';
import { type BezierPatch, quadCagePatches } from '@core/geometry/subdivisionPatches';

const empty = createEmptyDocument();
const run = (doc: CadDocument, name: string, params: object): ReturnType<typeof execute> =>
  execute(doc, name, params as Record<string, unknown>);
interface Data {
  readonly g1Method: string | null;
  readonly g1Choice: { chosen: string; reason: string; exactDeviation: number | null; fitDeviation: number | null } | null;
  readonly g1Exact: { method: string; freeQuads: number; patchCount: number; objective: string } | null;
  readonly exactG1Refused: Array<{ reason: string; quads: number; valences: number[] }>;
  readonly maxDeviation: number;
  readonly plainMaxDeviation: number | null;
  readonly deviationRatio: number | null;
  readonly warnings: string[];
  readonly maxEvG1Deg: number;
  readonly patchCount: number;
}
const valenceOf = (cage: Cage): number[] => {
  const topology = buildTopology(cage.vertices.length, cage.faces);
  return topology.vertexEdges.map((edges, v) => (edges.length === (topology.vertexFaces[v] as number[]).length ? edges.length : 4));
};

/** The document with the cage as a subdivision entity (open: an open surface), and the id the command gave it. */
function solid(cage: Cage, open = false): { doc: CadDocument; id: string } {
  const made = run(empty, 'add_subdivision_solid', {
    vertices: cage.vertices,
    faces: cage.faces,
    creases: [],
    levels: 1,
    ...(open ? { boundary: 'edge_and_corner' } : {}),
  });
  expect(made.error, made.summary).toBeUndefined();
  return { doc: made.document, id: made.affected[0] as string };
}
const convert = (cage: Cage, params: object = {}, open = false): { result: ReturnType<typeof execute>; data: Data } => {
  const { doc, id } = solid(cage, open);
  const result = run(doc, 'subdivision_to_nurbs', { id, extraordinary: 'G1', ...params });
  expect(result.error, result.summary).toBeUndefined();
  return { result, data: result.data as Data };
};

/** A box without its top face (a bowl: one segment per side): its boundary edges are creases whose quads stay fixed, which the exact solve cannot satisfy (contradiction). */
function bowl(): Cage {
  const box = boxCage([2, 2, 2], [1, 1, 1]);
  return { vertices: box.vertices, faces: box.faces.filter((face) => !face.every((v) => (box.vertices[v] as Vec3)[2] === 1)), creases: [] };
}

describe('g1Solve "auto" keeps the exact solution only when it stays near the limit surface', () => {
  it('a cube and a box 2 x 2 x 2 keep the fit (the exact deviation is 3x and 11x the plain patches, the fit 1.1x and 1.3x), and say why; a cylinder keeps the exact one (1.15x)', () => {
    const cube = convert(boxCage([2, 2, 2], [1, 1, 1]), { tangentToleranceDeg: 0.5 });
    expect(cube.data.g1Method).toBe('fit');
    expect(cube.data.g1Choice).toMatchObject({ chosen: 'fit', reason: expect.stringContaining('exceeds max(1.25 x the fit') });
    expect(cube.data.g1Choice?.exactDeviation as number).toBeGreaterThan(2 * (cube.data.g1Choice?.fitDeviation as number));
    expect(cube.data.g1Exact).toBeNull();
    expect(cube.result.summary).toContain('G1 fit');
    const box = convert(boxCage([2, 2, 2], [2, 2, 2]), { tangentToleranceDeg: 0.5 });
    expect(box.data.g1Method).toBe('fit');
    const cylinder = convert(cylinderCage(1, 2, 8, 2), { tangentToleranceDeg: 0.5 });
    expect(cylinder.data).toMatchObject({ g1Method: 'exact', g1Exact: { method: 'edges-freed', patchCount: 80, objective: 'limit' } });
    expect(cylinder.data.g1Choice?.chosen).toBe('exact');
    expect(cylinder.result.summary).toContain('G1 exact');
  });

  it('when the fit misses the tangent tolerance the exact solution is kept whatever it costs; a larger deviationTolerance accepts it too', () => {
    const cube = boxCage([2, 2, 2], [1, 1, 1]);
    const tight = convert(cube, { tangentToleranceDeg: 0.01 });
    expect(tight.data).toMatchObject({
      g1Method: 'exact',
      g1Choice: { chosen: 'exact', reason: 'only the exact solve meets the tangent tolerance' },
    });
    const accepted = convert(cube, { tangentToleranceDeg: 0.5, deviationTolerance: 0.1 });
    expect(accepted.data.g1Method).toBe('exact');
    expect(accepted.data.g1Choice?.reason).toContain('within max(');
  });

  it('"exact" and "fit" force their method: the exact one on a box (data.maxDeviation 11x the plain patches, DIR_CONVERT_G1_SHAPE_MOVED in the data and the summary), the fit on a cylinder', () => {
    const box = convert(boxCage([2, 2, 2], [2, 2, 2]), { g1Solve: 'exact' });
    expect(box.data).toMatchObject({ g1Method: 'exact', g1Exact: { method: 'edges-freed' } });
    expect(box.data.maxEvG1Deg).toBeLessThan(1e-5);
    expect(box.data.deviationRatio as number).toBeGreaterThan(8);
    expect(box.data.maxDeviation / (box.data.plainMaxDeviation as number)).toBeCloseTo(box.data.deviationRatio as number, 5);
    expect(box.data.warnings).toContain('DIR_CONVERT_G1_SHAPE_MOVED');
    expect(box.result.summary).toMatch(/DIR_CONVERT_G1_SHAPE_MOVED: G1 exact, deviation [\d.e-]+ \w+ = 1\d(\.\d+)?x the G0 patches/);
    const fit = convert(cylinderCage(1, 2, 8, 2), { g1Solve: 'fit' });
    expect(fit.data).toMatchObject({ g1Method: 'fit', g1Exact: null });
    expect(fit.data.warnings).not.toContain('DIR_CONVERT_G1_SHAPE_MOVED');
  });

  it('a G0 conversion reports no G1 method, no choice and no ratio', () => {
    const { doc, id } = solid(boxCage([2, 2, 2], [1, 1, 1]));
    const result = run(doc, 'subdivision_to_nurbs', { id });
    expect(result.data).toMatchObject({ g1Method: null, g1Choice: null, plainMaxDeviation: null, deviationRatio: null });
  });
});

describe('the exact solve is bounded and refuses by name', () => {
  it('an open bowl through the command: refused groups are named in the data and the summary, the fit is kept, and it ends within a stated time even with the tightest tolerance (no exact retry on finer levels)', () => {
    const started = performance.now();
    const { result, data } = convert(bowl(), { tangentToleranceDeg: 0.01 }, true);
    const seconds = (performance.now() - started) / 1000;
    expect(seconds).toBeLessThan(120);
    expect(data.g1Method).toBe('fit');
    expect(data.exactG1Refused.length).toBeGreaterThan(0);
    expect(data.exactG1Refused.every((group) => group.reason === 'contradiction')).toBe(true);
    expect(result.summary).toMatch(/G1 fit \(\d+ group\(s\) refused by the exact solve\)/);
    expect(data.g1Choice?.reason).toMatch(/exact solve/);
  }, 180_000);

  it('a work budget too small for the group refuses it as "work budget" (dense path and conjugate-gradient path) and leaves the poles as given', () => {
    for (const [cage, objective] of [
      [boxCage([2, 2, 2], [2, 2, 2]), 'limit'],
      [cylinderCage(1, 2, 24, 2), 'start'],
    ] as const) {
      const refined = subdivide(cage, 1);
      const patches = quadCagePatches(refined);
      const result = solveExactG1(refined, patches, valenceOf(refined), { maxWork: 1000 });
      expect(result.groups.length).toBeGreaterThan(0);
      expect(result.groups.every((group) => !group.consistent && group.reason === 'work budget' && group.objective === objective)).toBe(
        true,
      );
      expect(JSON.stringify(result.patches)).toBe(JSON.stringify(patches));
    }
  });

  it('the objective is "start" for a group too big for the dense path (a 24-sided cylinder) and the exact solution still holds', () => {
    const { data } = convert(cylinderCage(1, 2, 24, 2), { g1Solve: 'exact', tangentToleranceDeg: 0.5 });
    expect(data).toMatchObject({ g1Method: 'exact', g1Exact: { objective: 'start' } });
  }, 120_000);

  it('whole-cage fallback: with no ring allowed around the star the box is solved by freeing every quad, and without that fallback it is refused', () => {
    const refined = subdivide(boxCage([2, 2, 2], [2, 2, 2]), 1);
    const patches = quadCagePatches(refined);
    const result = solveExactG1(refined, patches, valenceOf(refined), { mostRings: 0 });
    expect(result.method).toBe('edges-freed');
    expect(result.freeQuads).toBe(96);
    expect(result.groups.every((group) => group.consistent)).toBe(true);
  });

  it('a folded pair (the two patches on the same side of their edge: a factor a below zero) is a degenerate edge, not a G1 pair', () => {
    const cage: Cage = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [-2, 0, 0],
        [-2, 1, 0],
      ],
      faces: [
        [0, 1, 2, 3],
        [1, 4, 5, 2],
      ],
      creases: [],
    };
    const grid = (x0: number, width: number): BezierPatch =>
      Array.from({ length: 16 }, (_, k): Vec3 => [x0 + (width * Math.floor(k / 4)) / 3, (k % 4) / 3, 0]);
    const patches = [grid(0, 1), grid(1, -3)];
    const result = solveExactG1(cage, patches, [3, 4, 4, 4, 3, 4]);
    expect(result.groups.every((group) => !group.consistent)).toBe(true);
    expect(result.groups.some((group) => group.reason === 'degenerate edge' && group.residual === Infinity)).toBe(true);
    expect(JSON.stringify(result.patches)).toBe(JSON.stringify(patches));
  });

  it('cageToNurbs: "auto" at a finer level does not retry an exact solve that was refused (an open bowl builds without it)', () => {
    const result = cageToNurbs(bowl(), { packed: false, samples: 2, fitTangents: true, g1Solve: 'auto', tangentToleranceDeg: 0.5 });
    expect(result.g1Method).toBe('fit');
    expect(result.exactRefused.length).toBeGreaterThan(0);
  });
});
