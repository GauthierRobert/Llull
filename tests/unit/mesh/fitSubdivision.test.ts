/** 07 MSH M6: fit_subdivision_to_mesh (pure TypeScript): analytic oracles on a sphere, a creased box and a torus, scale sweep, frames, interpolation, refusals, purity, replay. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { fastMeasure } from '@core/geometry/mesh/fastMeasure';
import { buildFitOperator, limitSurfaceMesh } from '@core/geometry/subd/fitOperator';
import { boxCage } from '@core/geometry/subdivision';
import type { Cage } from '@core/geometry/subdivision';
import { type CadDocument, type MeshData, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { docWithMeshes, icosphere, torus, type IndexedMesh } from '../../helpers/meshFixtures';
import { quadBox, quadSphere, tessellatedBox } from '../../helpers/quadFixtures';

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;
const codeOf = (result: { error?: { code: string } }): string | undefined => result.error?.code;

interface Quads {
  readonly positions: ReadonlyArray<number>;
  readonly quads: ReadonlyArray<number>;
}
const cageOf = (q: Quads, map: (p: Vec3) => Vec3 = (p) => p): Cage => ({
  vertices: Array.from({ length: q.positions.length / 3 }, (_, i) =>
    map([q.positions[3 * i] as number, q.positions[3 * i + 1] as number, q.positions[3 * i + 2] as number]),
  ),
  faces: Array.from({ length: q.quads.length / 4 }, (_, f) => q.quads.slice(4 * f, 4 * f + 4)),
  creases: [],
});

/** A document with the target mesh and a subdivision solid of `cage`; returns the two ids. */
function setup(
  target: IndexedMesh,
  cage: Cage,
  extra: Record<string, unknown> = {},
): { doc: CadDocument; cageId: string; targetId: string } {
  const { doc: withTarget, ids } = docWithMeshes(target);
  const added = execute(withTarget, 'add_subdivision_solid', {
    vertices: cage.vertices,
    faces: cage.faces,
    creases: cage.creases,
    levels: 2,
    ...extra,
  });
  expect(added.error).toBeUndefined();
  return { doc: added.document, cageId: added.affected[0] as string, targetId: ids[0] as string };
}

const entityOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;
const limitOf = (doc: CadDocument, id: string, level = 3): MeshData => {
  const e = entityOf(doc, id);
  return limitSurfaceMesh({ vertices: e.vertices, faces: e.faces, creases: e.creases }, level).mesh;
};
const radii = (mesh: { positions: ReadonlyArray<number> }, centre: Vec3 = [0, 0, 0]): number[] =>
  Array.from({ length: mesh.positions.length / 3 }, (_, i) =>
    Math.hypot(
      (mesh.positions[3 * i] as number) - centre[0],
      (mesh.positions[3 * i + 1] as number) - centre[1],
      (mesh.positions[3 * i + 2] as number) - centre[2],
    ),
  );

const SPHERE_VOLUME = (4 / 3) * Math.PI * 10 ** 3;
const sphere = icosphere(10, 5);
const sphereSetup = setup(sphere, cageOf(quadSphere(10, 8)));

describe('fit_subdivision_to_mesh', () => {
  it('fits a sphere cage to an icosphere: limit surface on the sphere to well under 0.05, topology and ids kept', () => {
    const { doc, cageId, targetId } = sphereSetup;
    const before = entityOf(doc, cageId);
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05, levels: 3 });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([cageId]);
    expect(result.document.order).toEqual(doc.order);
    const after = entityOf(result.document, cageId);
    expect(after.faces).toEqual(before.faces);
    expect(after.elementIds).toEqual(before.elementIds);
    expect(after.levels).toBe(3);
    expect(after.vertices).not.toEqual(before.vertices);
    const data = dataOf(result);
    expect(data).toMatchObject({ converged: true, fitLevel: 3, verifyLevel: 4, unit: 'mm', cageId, targetId });
    expect(data['maxDeviation'] as number).toBeLessThan(0.02);
    expect((data['initial'] as { max: number }).max).toBeGreaterThan(0.15);
    expect(data['rounds'] as number).toBeGreaterThanOrEqual(1);
    expect(data['warnings']).toEqual([]);
    expect(result.summary).toContain('converged');
    // analytic oracle: every limit point of the fitted cage lies on the sphere R 10 (the target's chords are 0.005 inside)
    const limit = limitOf(result.document, cageId, 4);
    for (const r of radii(limit)) expect(Math.abs(r - 10)).toBeLessThan(0.015);
    const volume = fastMeasure(limit).volume as number;
    expect(Math.abs(volume / SPHERE_VOLUME - 1)).toBeLessThan(0.002);
    // before the fit the limit surface sat inside the cage (about -2 % volume)
    const unfitted = fastMeasure(limitOf(doc, cageId, 4)).volume as number;
    expect(unfitted / SPHERE_VOLUME - 1).toBeLessThan(-0.01);
  });

  it('is scale-invariant: the relative deviation is the same for spheres of diameter 1, 10, 100 and 1000 mm', () => {
    const relative: number[] = [];
    for (const radius of [0.5, 5, 50, 500]) {
      const { doc, cageId, targetId } = setup(icosphere(radius, 4), cageOf(quadSphere(radius, 6)));
      const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.004 * radius, levels: 2 });
      expect(result.error).toBeUndefined();
      expect(dataOf(result)['converged']).toBe(true);
      relative.push((dataOf(result)['maxDeviation'] as number) / radius);
      const limit = limitOf(result.document, cageId, 3);
      const spread = radii(limit).map((r) => Math.abs(r / radius - 1));
      expect(Math.max(...spread)).toBeLessThan(0.0035);
    }
    for (const value of relative) expect(Math.abs(value / (relative[0] as number) - 1)).toBeLessThan(1e-3);
  });

  it('keeps the creases of a box cage and fits the box exactly: volume 1000, corners on the corners', () => {
    const half = 5;
    const q = quadBox(half, 4);
    const base = cageOf(q, (p) => [p[0] * 0.9 + 0.2, p[1] * 0.9 - 0.1, p[2] * 0.9 + 0.15]);
    const onCubeEdge = (a: number, b: number): boolean => {
      const axes = [0, 1, 2].filter((k) => {
        const [x, y] = [q.positions[3 * a + k] as number, q.positions[3 * b + k] as number];
        return Math.abs(Math.abs(x) - half) < 1e-9 && Math.abs(x - y) < 1e-9;
      });
      return axes.length >= 2;
    };
    const creases = new Map<string, [number, number]>();
    for (const face of base.faces)
      face.forEach((a, k) => {
        const b = face[(k + 1) % 4] as number;
        if (onCubeEdge(a, b)) creases.set(`${Math.min(a, b)}-${Math.max(a, b)}`, [a, b]);
      });
    expect(creases.size).toBe(48);
    const { doc, cageId, targetId } = setup(tessellatedBox(half, 8), { ...base, creases: [...creases.values()] });
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05, levels: 2 });
    expect(result.error).toBeUndefined();
    const data = dataOf(result);
    expect(data['converged']).toBe(true);
    expect(data['maxDeviation'] as number).toBeLessThan(0.05);
    expect(entityOf(result.document, cageId).creases).toEqual(entityOf(doc, cageId).creases);
    const limit = limitOf(result.document, cageId, 3);
    expect(Math.abs((fastMeasure(limit).volume as number) / 1000 - 1)).toBeLessThan(0.005);
    const extent = [0, 1, 2].map((k) => Math.max(...limit.positions.filter((_, i) => i % 3 === k).map(Math.abs)));
    for (const e of extent) expect(Math.abs(e - half)).toBeLessThan(0.03);
  });

  it('fits a torus cage: deviation under 0.05 and the closed-form volume 2 pi^2 R r^2', () => {
    const [R, r, nu, nv] = [10, 3, 24, 12];
    const vertices: Vec3[] = [];
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const [a, b] = [(2 * Math.PI * i) / nu, (2 * Math.PI * j) / nv];
        vertices.push([(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r * Math.sin(b)]);
      }
    const at = (i: number, j: number): number => (i % nu) * nv + (j % nv);
    const faces: number[][] = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
    const { doc, cageId, targetId } = setup(torus(R, r, 96, 48), { vertices, faces, creases: [] });
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05 });
    expect(result.error).toBeUndefined();
    expect(dataOf(result)['converged']).toBe(true);
    expect(dataOf(result)['maxDeviation'] as number).toBeLessThan(0.03);
    const volume = fastMeasure(limitOf(result.document, cageId, 3)).volume as number;
    expect(Math.abs(volume / (2 * Math.PI ** 2 * R * r * r) - 1)).toBeLessThan(0.003);
  });

  it('works in the frame of a moved and rotated solid and reports almost the same deviation as at the origin (the cage is turned against the tessellation of the target)', () => {
    const centre: [number, number, number] = [30, -20, 12];
    const plain = execute(sphereSetup.doc, 'fit_subdivision_to_mesh', {
      cageId: sphereSetup.cageId,
      targetId: sphereSetup.targetId,
      maxDeviation: 0.05,
    });
    const moved = setup(icosphere(10, 5, centre), cageOf(quadSphere(10, 8)), { position: centre, rotation: [0.4, -0.3, 0.2] });
    const result = execute(moved.doc, 'fit_subdivision_to_mesh', { cageId: moved.cageId, targetId: moved.targetId, maxDeviation: 0.05 });
    expect(result.error).toBeUndefined();
    expect(Math.abs((dataOf(result)['maxDeviation'] as number) - (dataOf(plain)['maxDeviation'] as number))).toBeLessThan(5e-4);
    const entity = entityOf(result.document, moved.cageId);
    const limit = limitSurfaceMesh({ vertices: entity.vertices, faces: entity.faces, creases: [] }, 3).mesh;
    for (const r of radii(limit)) expect(Math.abs(r - 10)).toBeLessThan(0.015);
  });

  it('interpolate pins the cage-vertex limit points to target vertices', () => {
    const { doc, cageId, targetId } = sphereSetup;
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05, interpolate: true, levels: 2 });
    expect(result.error).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ interpolate: true, converged: true });
    const entity = entityOf(result.document, cageId);
    const operator = buildFitOperator({ vertices: entity.vertices, faces: entity.faces, creases: [] }, 2);
    const flat = entity.vertices.flat();
    for (let v = 0; v < entity.vertices.length; v += 7) {
      const limit = [0, 1, 2].map((axis) => {
        let total = 0;
        for (let k = operator.rowStart[v] as number; k < (operator.rowStart[v + 1] as number); k++)
          total += (operator.value[k] as number) * (flat[3 * (operator.colIdx[k] as number) + axis] as number);
        return total;
      });
      expect(Math.abs(Math.hypot(limit[0] as number, limit[1] as number, limit[2] as number) - 10)).toBeLessThan(0.01);
    }
  });

  it('applies the best cage and warns when maxDeviation is not reached', () => {
    const { doc, cageId, targetId } = sphereSetup;
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 1e-7, iterations: 2 });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([cageId]);
    const data = dataOf(result);
    expect(data['converged']).toBe(false);
    expect((data['warnings'] as Array<{ code: string }>)[0]?.code).toBe('MESH_FIT_NOT_CONVERGED');
    expect(result.summary).toContain('NOT converged');
    expect(data['maxDeviation'] as number).toBeLessThan((data['initial'] as { max: number }).max / 10);
    expect(entityOf(result.document, cageId).vertices).not.toEqual(entityOf(doc, cageId).vertices);
  });

  it('is pure and replays to the same cage', () => {
    const { doc, cageId, targetId } = sphereSetup;
    const params = { cageId, targetId, maxDeviation: 0.05 };
    expectPure(doc, () => execute(doc, 'fit_subdivision_to_mesh', params));
    const a = execute(doc, 'fit_subdivision_to_mesh', params);
    const b = execute(doc, 'fit_subdivision_to_mesh', params);
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
    const replayed = execute(a.document, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(entityOf(replayed.document, cageId).vertices).toEqual(entityOf(a.document, cageId).vertices);
  });

  it('refuses bad input without touching the document', () => {
    const { doc, cageId, targetId } = sphereSetup;
    const run = (params: Record<string, unknown>): ReturnType<typeof execute> => execute(doc, 'fit_subdivision_to_mesh', params);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ cageId: 'nope', targetId, maxDeviation: 0.05 }, 'DIR_ENTITY_NOT_FOUND'],
      [{ cageId: targetId, targetId: cageId, maxDeviation: 0.05 }, 'DIR_ENTITY_NOT_FOUND'],
      [{ cageId, targetId: 'nope', maxDeviation: 0.05 }, 'MESH_ENTITY_NOT_FOUND'],
      [{ cageId, targetId: cageId, maxDeviation: 0.05 }, 'MESH_PARAM_INVALID'],
      [{ cageId, targetId, maxDeviation: 0 }, 'CMD_INVALID_PARAMS'],
      [{ cageId, targetId, maxDeviation: 0.05, levels: 5 }, 'MESH_PARAM_INVALID'],
      [{ cageId, targetId, maxDeviation: 0.05, iterations: 0 }, 'CMD_INVALID_PARAMS'],
      [{ cageId, targetId, maxDeviation: 0.05, levels: 0 }, 'CMD_INVALID_PARAMS'],
    ];
    for (const [params, code] of cases) {
      const result = run(params);
      expectNoOp(result, doc);
      expect(codeOf(result), JSON.stringify(params)).toBe(code);
    }
  });

  it('refuses a 2D target, a mirror-symmetric cage, a broken cage and a cage with too many samples', () => {
    const { doc, cageId, targetId } = sphereSetup;
    const line = execute(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 5],
      ],
    });
    expect(line.affected, line.summary).toHaveLength(1);
    const flat = execute(line.document, 'fit_subdivision_to_mesh', { cageId, targetId: line.affected[0], maxDeviation: 0.05 });
    expectNoOp(flat, line.document);
    expect(codeOf(flat)).toBe('MESH_NOT_A_MESH');

    const mirrored = execute(doc, 'set_cage_symmetry', { id: cageId, planes: ['x'] });
    expect(mirrored.error).toBeUndefined();
    const symmetric = execute(mirrored.document, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05 });
    expectNoOp(symmetric, mirrored.document);
    expect(codeOf(symmetric)).toBe('MESH_FIT_SYMMETRY');

    const entity = entityOf(doc, cageId);
    const broken = {
      ...doc,
      entities: { ...doc.entities, [cageId]: { ...entity, faces: [[0, 1, 2, 9999], ...entity.faces.slice(1)] } },
    } as CadDocument;
    const invalid = execute(broken, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05 });
    expectNoOp(invalid, broken);
    expect(codeOf(invalid)).toBe('MESH_FIT_CAGE_INVALID');

    const big = boxCage([20, 20, 20], [72, 72, 72]);
    const bigSetup = setup(sphere, big, { levels: 1 });
    const tooLarge = execute(bigSetup.doc, 'fit_subdivision_to_mesh', {
      cageId: bigSetup.cageId,
      targetId: bigSetup.targetId,
      maxDeviation: 0.05,
    });
    expectNoOp(tooLarge, bigSetup.doc);
    expect(codeOf(tooLarge)).toBe('MESH_FIT_TOO_LARGE');
  });

  it('fits an open cage (boundary edges stay sharp) to a sculpted patch and says when 6 x 6 faces are too coarse', () => {
    const grid = execute(createEmptyDocument(), 'add_grid_mesh', { size: [20, 20], cells: [40, 40] });
    const patch = grid.affected[0] as string;
    const sculpted = execute(grid.document, 'sculpt_mesh', {
      id: patch,
      brush: 'draw',
      stamps: [{ center: [0, 0, 0] }],
      radius: 5,
      strength: 1,
      falloff: 'smooth',
      direction: 'normal',
    });
    const n = 6;
    const vertices: Vec3[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push([(i / n - 0.5) * 20, (j / n - 0.5) * 20, 0]);
    const faces: number[][] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) faces.push([j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i]);
    const cage = execute(sculpted.document, 'add_subdivision_solid', { vertices, faces, boundary: 'edge_and_corner', levels: 2 });
    expect(cage.error).toBeUndefined();
    const cageId = cage.affected[0] as string;
    const result = execute(cage.document, 'fit_subdivision_to_mesh', { cageId, targetId: patch, maxDeviation: 0.02 });
    expect(result.error).toBeUndefined();
    const data = dataOf(result);
    expect((data['initial'] as { max: number }).max).toBeGreaterThan(0.9);
    expect(data['maxDeviation'] as number).toBeLessThan(0.1);
    expect(data['converged']).toBe(false);
    expect(entityOf(result.document, cageId).boundary).toBe('edge_and_corner');
    const finer = execute(cage.document, 'fit_subdivision_to_mesh', { cageId, targetId: patch, maxDeviation: 0.2 });
    expect(dataOf(finer)['converged']).toBe(true);
  });

  it('never throws on hostile input: a non-finite, collapsed, huge or distant cage, a one-triangle target, a degenerate target', () => {
    const { doc, cageId, targetId } = sphereSetup;
    const entity = entityOf(doc, cageId);
    const withCage = (vertices: SubdivisionEntity['vertices']): CadDocument =>
      ({ ...doc, entities: { ...doc.entities, [cageId]: { ...entity, vertices } } }) as CadDocument;
    const run = (base: CadDocument, id: string): ReturnType<typeof execute> =>
      execute(base, 'fit_subdivision_to_mesh', { cageId, targetId: id, maxDeviation: 0.05, iterations: 3 });
    const nan = withCage(entity.vertices.map((p, i): Vec3 => (i === 3 ? [Number.NaN, 0, 0] : p)));
    expectNoOp(run(nan, targetId), nan);
    expect(codeOf(run(nan, targetId))).toBe('MESH_FIT_CAGE_INVALID');
    for (const scale of [0, 1e-12, 1e150]) {
      const squashed = withCage(entity.vertices.map((p): Vec3 => [p[0] * scale, p[1] * scale, p[2] * scale]));
      const result = run(squashed, targetId);
      expectNoOp(result, squashed);
      expect(codeOf(result), `scale ${scale}`).toBe('MESH_FIT_CAGE_FAR');
    }
    const moved = withCage(entity.vertices.map((p): Vec3 => [p[0] + 500, p[1], p[2]]));
    expect(codeOf(run(moved, targetId))).toBe('MESH_FIT_CAGE_FAR');
    const one = docWithMeshes({ positions: [0, 0, 0, 12, 0, 0, 0, 12, 0], indices: [0, 1, 2] });
    const single = execute(
      { ...doc, entities: { ...doc.entities, ...one.doc.entities }, order: [...doc.order, ...one.doc.order] } as CadDocument,
      'fit_subdivision_to_mesh',
      { cageId, targetId: one.ids[0], maxDeviation: 0.05, iterations: 3 },
    );
    expect(single.error).toBeUndefined();
    expect(dataOf(single)['converged']).toBe(false);
    expect((single.document.entities[cageId] as SubdivisionEntity).vertices.flat().every(Number.isFinite)).toBe(true);
  });

  it('lowers the sampling level instead of refusing when levels asks for more samples than the cap', () => {
    const cage = cageOf(quadSphere(10, 24));
    const { doc, cageId, targetId } = setup(sphere, cage, { levels: 1 });
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05, levels: 4, iterations: 2 });
    expect(result.error).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ fitLevel: 2, levels: 4 });
    expect(dataOf(result)['samples'] as number).toBeLessThanOrEqual(120_000);
  });
});
