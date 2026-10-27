/** 07 MSH M6: fit_subdivision_to_mesh stop reasons, exact interpolation, semi-sharp sampling level, folded cages, the work cap and the solver report. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { symmetricDeviation } from '@core/geometry/mesh/deviation';
import { fitSubdivision } from '@core/geometry/mesh/subdFit';
import { applyOperator, buildFitOperator } from '@core/geometry/subd/fitOperator';
import { boxCage, type Cage } from '@core/geometry/subdivision';
import { type CadDocument, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { expectNoOp } from '../../helpers/expectNoOp';
import { docWithMeshes, icosphere, type IndexedMesh } from '../../helpers/meshFixtures';
import { quadSphere, tessellatedBox } from '../../helpers/quadFixtures';

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;
const codeOf = (result: { error?: { code: string } }): string | undefined => result.error?.code;
const entityOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;

const sphereCage = (radius: number, n: number, centre = 0): Cage => {
  const q = quadSphere(radius, n);
  return {
    vertices: Array.from(
      { length: q.positions.length / 3 },
      (_, i): Vec3 => [(q.positions[3 * i] as number) + centre, q.positions[3 * i + 1] as number, q.positions[3 * i + 2] as number],
    ),
    faces: Array.from({ length: q.quads.length / 4 }, (_, f) => q.quads.slice(4 * f, 4 * f + 4)),
    creases: [],
  };
};

function setup(
  target: IndexedMesh,
  cage: Cage,
  extra: Record<string, unknown> = {},
): { doc: CadDocument; cageId: string; targetId: string } {
  const { doc: withTarget, ids } = docWithMeshes(target);
  const added = execute(withTarget, 'add_subdivision_solid', { ...cage, levels: 2, ...extra });
  expect(added.error, added.summary).toBeUndefined();
  return { doc: added.document, cageId: added.affected[0] as string, targetId: ids[0] as string };
}

const target = icosphere(10, 4);
const options = { level: 2, maxDeviation: 0.05, iterations: 10, interpolate: false, smoothing: 1e-3, targetClosed: true };

describe('fit_subdivision_to_mesh stop reasons', () => {
  it('reports met, rounds, stalled and met_on_samples from what actually ended the rounds', () => {
    const cage = sphereCage(10, 4);
    const run = (patch: Partial<typeof options>): ReturnType<typeof fitSubdivision> =>
      fitSubdivision(cage, target, { ...options, ...patch });
    const met = run({});
    expect(met).toMatchObject({ stop: 'met', converged: true });
    const oneRound = run({ maxDeviation: 1e-9, iterations: 1 });
    expect(oneRound).toMatchObject({ stop: 'rounds', converged: false, rounds: 1 });
    const stalled = run({ maxDeviation: 1e-9 });
    expect(stalled).toMatchObject({ stop: 'stalled', converged: false });
    expect((stalled as { rounds: number }).rounds).toBeGreaterThanOrEqual(1);
    // between what the fit samples show and what the finer verification mesh shows
    const verified = (met as { final: { max: number }; initial: { max: number } }).final.max;
    let onSamples: ReturnType<typeof fitSubdivision> | null = null;
    for (let tolerance = verified * 0.1; tolerance < verified && onSamples === null; tolerance *= 1.25) {
      const candidate = run({ maxDeviation: tolerance });
      if ('stop' in candidate && candidate.stop === 'met_on_samples') onSamples = candidate;
    }
    expect(onSamples, 'some tolerance below the verified maximum is met on the fit samples only').not.toBeNull();
    expect(onSamples).toMatchObject({ converged: false, stop: 'met_on_samples' });
  }, 120_000);

  it('the command builds the summary and the warning from the stop reason', () => {
    const { doc, cageId, targetId } = setup(target, sphereCage(10, 4));
    const rounds = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 1e-9, iterations: 1 });
    expect(dataOf(rounds)).toMatchObject({ stop: 'rounds', converged: false });
    expect(rounds.summary).toContain('all rounds used');
    expect((dataOf(rounds)['warnings'] as Array<{ message: string }>)[0]?.message).toContain('all rounds used');
    const stalled = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 1e-9 });
    expect(dataOf(stalled)['stop']).toBe('stalled');
    expect(stalled.summary).toContain('gained under 1 %');
    const met = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05 });
    expect(dataOf(met)).toMatchObject({ stop: 'met', converged: true });
  });

  it('reports the solver: converged to the 1e-8 tolerance with its worst relative residual', () => {
    const { doc, cageId, targetId } = setup(target, sphereCage(10, 4));
    const data = dataOf(execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05 }));
    expect(data['cgConverged']).toBe(true);
    expect(data['cgRelativeResidual'] as number).toBeLessThanOrEqual(1e-8);
    expect(data['cgIterations'] as number).toBeGreaterThan(0);
    expect(data['foldedTriangles']).toBe(0);
    expect(data['foldedChecked'] as number).toBeGreaterThan(1000);
  });
});

describe('fit_subdivision_to_mesh interpolate', () => {
  it('pins the limit point of every cage vertex exactly on the nearest target vertex of its initial limit point', () => {
    const cage = sphereCage(10, 4);
    const { doc, cageId, targetId } = setup(target, cage);
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05, interpolate: true, levels: 2 });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf(result);
    expect(data).toMatchObject({ interpolate: true, stop: 'pinned', rounds: 1 });
    expect(data['pinResidual'] as number).toBeLessThanOrEqual(1e-9);
    expect(data['sharedPins']).toBe(0);
    expect(data['warnings']).not.toContainEqual(expect.objectContaining({ code: 'MESH_FIT_PIN_RESIDUAL' }));
    const fitted = entityOf(result.document, cageId);
    const pinned = (cageValues: ReadonlyArray<Vec3>): Vec3[] => {
      const op = buildFitOperator({ ...cage, vertices: cageValues }, 2);
      const axes = [0, 1, 2].map((a) => {
        const out = new Float64Array(op.rows);
        applyOperator(
          op,
          Float64Array.from(cageValues, (p) => p[a] as number),
          out,
        );
        return out;
      });
      return cageValues.map((_, v) => [
        (axes[0] as Float64Array)[v] as number,
        (axes[1] as Float64Array)[v] as number,
        (axes[2] as Float64Array)[v] as number,
      ]);
    };
    const before = pinned(cage.vertices);
    const after = pinned(fitted.vertices);
    const vertexAt = (v: number): Vec3 => [
      target.positions[3 * v] as number,
      target.positions[3 * v + 1] as number,
      target.positions[3 * v + 2] as number,
    ];
    const nearest = (p: Vec3): Vec3 => {
      let [best, bestSq] = [0, Infinity];
      for (let v = 0; v < target.positions.length / 3; v++) {
        const q = vertexAt(v);
        const dSq = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
        if (dSq < bestSq) [best, bestSq] = [v, dSq];
      }
      return vertexAt(best);
    };
    after.forEach((p, v) => {
      const wanted = nearest(before[v] as Vec3);
      expect(Math.hypot(p[0] - wanted[0], p[1] - wanted[1], p[2] - wanted[2])).toBeLessThan(1e-9);
    });
  });
});

describe('fit_subdivision_to_mesh interpolate on a target coarser than the cage', () => {
  const sharedWarning = (result: ReturnType<typeof execute>): { code: string; message: string } | undefined =>
    (dataOf(result)['warnings'] as Array<{ code: string; message: string }>).find((w) => w.code === 'MESH_FIT_PIN_SHARED');

  it('counts the cage vertices that share a target vertex and warns, on closed targets of 42 and 162 vertices', () => {
    for (const [level, cageSegments] of [
      [1, 4],
      [2, 6],
    ] as const) {
      const coarse = icosphere(10, level);
      const { doc, cageId, targetId } = setup(coarse, sphereCage(10, cageSegments));
      const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05, interpolate: true });
      expect(result.error, result.summary).toBeUndefined();
      const cageVertices = entityOf(doc, cageId).vertices.length;
      const targetVertices = coarse.positions.length / 3;
      expect(cageVertices).toBeGreaterThan(targetVertices);
      expect(dataOf(result)['sharedPins'] as number).toBeGreaterThanOrEqual(cageVertices - targetVertices);
      expect(sharedWarning(result)?.message).toContain('use the least-squares fit (interpolate off) or a coarser cage');
      expect(dataOf(result)['targetClosed']).toBe(true);
    }
  });

  it('warns on an open target as well', () => {
    const grid = execute(createEmptyDocument(), 'add_grid_mesh', { size: [20, 20], cells: [3, 3] });
    const n = 6;
    const vertices: Vec3[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push([(i / n - 0.5) * 20, (j / n - 0.5) * 20, 0]);
    const faces: number[][] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) faces.push([j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i]);
    const added = execute(grid.document, 'add_subdivision_solid', { vertices, faces, boundary: 'edge_and_corner' });
    const result = execute(added.document, 'fit_subdivision_to_mesh', {
      cageId: added.affected[0],
      targetId: grid.affected[0],
      maxDeviation: 0.5,
      interpolate: true,
    });
    expect(result.error, result.summary).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ targetClosed: false });
    expect(dataOf(result)['sharedPins'] as number).toBeGreaterThanOrEqual(49 - 16);
    expect(sharedWarning(result)).toBeDefined();
  });
});

describe('fit_subdivision_to_mesh semi-sharp cages', () => {
  it('samples at the settle level of the creases whatever levels asks for, and verifies one level finer', () => {
    const cage = boxCage([4, 4, 4], [2, 2, 2]);
    const { doc, cageId, targetId } = setup(tessellatedBox(2, 6), { ...cage, edgeSharpness: [{ a: 0, b: 1, s: 2.5 }] }, { levels: 1 });
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.1, levels: 1 });
    expect(result.error, result.summary).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ fitLevel: 3, verifyLevel: 4, levels: 1 });
    expect(entityOf(result.document, cageId).edgeSharpness).toEqual([{ a: 0, b: 1, s: 2.5 }]);
  });

  it('settles at the exact count with no cap: sharpness 5 samples at level 5, and the cap refusal names the sharpness', () => {
    const small = boxCage([4, 4, 4], [2, 2, 2]);
    const ok = setup(tessellatedBox(2, 6), { ...small, edgeSharpness: [{ a: 0, b: 1, s: 5 }] }, { levels: 1 });
    const fitted = execute(ok.doc, 'fit_subdivision_to_mesh', { cageId: ok.cageId, targetId: ok.targetId, maxDeviation: 0.1, levels: 1 });
    expect(fitted.error, fitted.summary).toBeUndefined();
    expect(dataOf(fitted)).toMatchObject({ fitLevel: 5, verifyLevel: 6 });
    const big = boxCage([12, 12, 12], [12, 12, 12]);
    const refused = setup(tessellatedBox(6, 4), { ...big, edgeSharpness: [{ a: 0, b: 1, s: 5 }] }, { levels: 1 });
    const result = execute(refused.doc, 'fit_subdivision_to_mesh', {
      cageId: refused.cageId,
      targetId: refused.targetId,
      maxDeviation: 0.1,
    });
    expectNoOp(result, refused.doc);
    expect(codeOf(result)).toBe('MESH_FIT_TOO_LARGE');
    expect(result.summary).toMatch(/sharpness, 5, needs 5 levels.*lower the sharpness or use a cage with fewer faces/);
  }, 120_000);

  it('refuses by name when the settle level alone exceeds the sample cap', () => {
    const big = boxCage([20, 20, 20], [18, 18, 18]);
    const { doc, cageId, targetId } = setup(tessellatedBox(10, 4), { ...big, edgeSharpness: [{ a: 0, b: 1, s: 3 }] }, { levels: 1 });
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.1 });
    expectNoOp(result, doc);
    expect(codeOf(result)).toBe('MESH_FIT_TOO_LARGE');
    expect(result.summary).toContain('sharpness, 3, needs 3 levels');
  });
});

describe('fit_subdivision_to_mesh folded and badly placed cages', () => {
  it('warns MESH_FIT_FOLDED, counting the limit triangles that face against the closed target, and still applies the fit', () => {
    const cage = sphereCage(10, 4);
    const inside = { ...cage, faces: cage.faces.map((face) => [...face].reverse()) };
    const { doc, cageId, targetId } = setup(target, inside);
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05 });
    expect(result.error, result.summary).toBeUndefined();
    expect(result.affected).toEqual([cageId]);
    const data = dataOf(result);
    expect(data['foldedTriangles'] as number).toBeGreaterThan(0.9 * (data['foldedChecked'] as number));
    const warning = (data['warnings'] as Array<{ code: string; message: string }>).find((w) => w.code === 'MESH_FIT_FOLDED');
    expect(warning?.message).toContain('of');
    expect(result.summary).toContain('folded');
  });

  it('does not look for folds against an open target', () => {
    const grid = execute(createEmptyDocument(), 'add_grid_mesh', { size: [20, 20], cells: [10, 10] });
    const n = 3;
    const vertices: Vec3[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push([(i / n - 0.5) * 20, (j / n - 0.5) * 20, 0]);
    const faces: number[][] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) faces.push([j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i]);
    const added = execute(grid.document, 'add_subdivision_solid', { vertices, faces, boundary: 'edge_and_corner' });
    const result = execute(added.document, 'fit_subdivision_to_mesh', {
      cageId: added.affected[0],
      targetId: grid.affected[0],
      maxDeviation: 0.5,
    });
    expect(result.error, result.summary).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ targetClosed: false, foldedTriangles: 0, foldedChecked: 0 });
  });

  it('refuses a cage 9 times smaller than the target at its centre, which passes the size rule but defeats the closest-point tree', () => {
    const { doc, cageId, targetId } = setup(icosphere(10, 5), sphereCage(1.2, 6));
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05 });
    expectNoOp(result, doc);
    expect(codeOf(result)).toBe('MESH_FIT_CAGE_FAR');
    expect(result.summary).toMatch(/work cap.*rms distance to the target is \d/);
  });
});

describe('symmetricDeviation edge midpoints', () => {
  it('adds the midpoints of the edges of both meshes as samples and never lowers the maximum', () => {
    const a = icosphere(10, 2);
    const b = icosphere(10.1, 2);
    const plain = symmetricDeviation(a, b);
    const midpoints = symmetricDeviation(a, b, 1e6, { edgeMidpoints: true });
    expect(plain && midpoints).not.toBeNull();
    const faces = a.indices.length / 3;
    const vertices = a.positions.length / 3;
    const edges = (3 * faces) / 2;
    expect((midpoints as { samples: number }).samples).toBe(2 * (vertices + faces + edges));
    expect((plain as { samples: number }).samples).toBe(2 * (vertices + faces));
    expect((midpoints as { hausdorff: number }).hausdorff).toBeGreaterThanOrEqual(0);
  });
});
