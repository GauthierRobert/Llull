/** 07 MSH M2: convex_hull, minkowski_sum, offset_mesh, hollow_mesh, repair_mesh (wrap), subdivide_mesh and mesh-engine `boolean` routing (VC-MSH-11..18, 35, 36). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyDocument, type MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { composeMeshEngines, resolveMeshEngine } from '@core/geometry/mesh/engine';
import { type MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createManifoldMeshEngine } from '@kernel-manifold/manifoldMeshEngine';
import { MANIFOLD_VERSION } from '@kernel-manifold/manifoldModule';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { cuboid, docWithMeshes, icosahedron, icosphere, relativeError, packJson } from '../../helpers/meshFixtures';

let manifold: MeshProcessingEngine;

beforeAll(async () => {
  manifold = await createManifoldMeshEngine();
  setMeshProcessingEngine(manifold);
  setGeometryKernel(await createManifoldKernel());
});

afterAll(() => {
  setMeshProcessingEngine(null);
  setGeometryKernel(null);
});

interface Data {
  readonly [key: string]: unknown;
}
const dataOf = (result: { data?: unknown }): Data => result.data as Data;

describe('provenance is pinned to the installed Manifold (D7)', () => {
  it('records manifold-3d at the version of node_modules', () => {
    const installed = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', '..', 'node_modules', 'manifold-3d', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(MANIFOLD_VERSION).toBe(installed.version);
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [10, 10, 10]), cuboid([0, 0, 0], [3, 3, 3]));
    const result = execute(doc, 'minkowski_sum', { a: ids[0], b: ids[1], op: 'difference', keepSources: true });
    expect(dataOf(result)['provenance']).toMatchObject({
      engine: 'manifold',
      version: `manifold-3d@${installed.version}`,
      deterministic: true,
    });
  });
});

describe('convex_hull (VC-MSH-11)', () => {
  const CUBE_PLUS_INTERIOR = [...cuboid([0, 0, 0], [10, 10, 10]).positions, 5, 5, 5, 2, 7, 3];
  const points = Array.from({ length: CUBE_PLUS_INTERIOR.length / 3 }, (_, i) => CUBE_PLUS_INTERIOR.slice(i * 3, i * 3 + 3));

  it('hulls cube corners plus interior points to a closed mesh of volume 1000 and area 600', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'convex_hull', { points });
    expect(result.error).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    const data = dataOf(result);
    expect([data['vertices'], data['faces'], data['closed']]).toEqual([8, 12, true]);
    expect(relativeError(data['volume'] as number, 1000)).toBeLessThan(1e-9);
    expect(relativeError(data['area'] as number, 600)).toBeLessThan(1e-9);
    expect(data).toMatchObject({ unit: 'mm', unverified: false });
    expect((result.document.entities[result.affected[0] as string] as MeshSolidEntity).brep).toBeUndefined();
  });

  it('adds entity vertices and removes the sources only with keepSources false', () => {
    const { doc, ids } = docWithMeshes(icosahedron());
    const kept = execute(doc, 'convex_hull', { ids });
    expect(kept.document.order).toEqual([ids[0], kept.affected[0]]);
    expect(dataOf(kept)['unverified']).toBe(true);
    expect(relativeError(dataOf(kept)['volume'] as number, 17.453559925)).toBeLessThan(1e-9);
    const consumed = execute(doc, 'convex_hull', { ids, keepSources: false });
    expect(consumed.document.order).toEqual(consumed.affected);
    expect(consumed.document.entities[ids[0] as string]).toBeUndefined();
  });

  it.each([
    [{}, 'MESH_HULL_DEGENERATE'],
    [
      {
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
      },
      'MESH_HULL_DEGENERATE',
    ],
    [
      {
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
      'MESH_HULL_DEGENERATE',
    ],
    [{ ids: ['ghost'] }, 'MESH_ENTITY_NOT_FOUND'],
  ])('refuses %j with %s', (params, code) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'convex_hull', params);
    expectNoOp(result, doc);
    expect(result.error?.code).toBe(code);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => execute(doc, 'convex_hull', { points }));
  });
});

describe('minkowski_sum (VC-MSH-12, 13, 14)', () => {
  const cases = (packJson('minkowski_cases.json') as { cube_plus_ball: { polyhedral: Array<{ expectedVolumeExactPolyhedral: number }> } })
    .cube_plus_ball.polyhedral;

  it.each([1, 2, 3])('cube 10 (+) icosphere r 2 level %i matches the exact polyhedral volume (1e-9)', (level) => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [10, 10, 10]), icosphere(2, level));
    const result = execute(doc, 'minkowski_sum', { a: ids[0], b: ids[1], op: 'sum', keepSources: true });
    expect(result.error).toBeUndefined();
    expect(result.document.order).toEqual([ids[0], ids[1], result.affected[0]]);
    expect(relativeError(dataOf(result)['volume'] as number, cases[level - 1]?.expectedVolumeExactPolyhedral as number)).toBeLessThan(1e-9);
    expect(dataOf(result)['provenance']).toMatchObject({ engine: 'ts' });
  });

  it('cube 10 (+) cube 3 = 13^3 and rewrites a in place by default', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [10, 10, 10]), cuboid([-1.5, -1.5, -1.5], [1.5, 1.5, 1.5]));
    const result = execute(doc, 'minkowski_sum', { a: ids[0], b: ids[1], op: 'sum' });
    expect(result.affected).toEqual([ids[0]]);
    expect(result.document.order).toEqual(ids);
    expect(relativeError(dataOf(result)['volume'] as number, 2197)).toBeLessThan(1e-12);
    expect(result.document.entities[ids[1] as string]).toBe(doc.entities[ids[1] as string]);
  });

  it('erodes with Manifold: cube 10 (-) cube 3 = 343 and cube 10 (-) icosphere r 2 = 216', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [10, 10, 10]), cuboid([-1.5, -1.5, -1.5], [1.5, 1.5, 1.5]), icosphere(2, 2));
    const small = execute(doc, 'minkowski_sum', { a: ids[0], b: ids[1], op: 'difference', keepSources: true });
    expect(relativeError(dataOf(small)['volume'] as number, 343)).toBeLessThan(1e-9);
    const ball = execute(doc, 'minkowski_sum', { a: ids[0], b: ids[2], op: 'difference', keepSources: true });
    expect(relativeError(dataOf(ball)['volume'] as number, 216)).toBeLessThan(1e-9);
  });

  it('refuses open operands, equal ids, empty erosions, unknown ids and a missing Manifold engine for erosion', () => {
    const open = { positions: cuboid([0, 0, 0], [1, 1, 1]).positions, indices: cuboid([0, 0, 0], [1, 1, 1]).indices.slice(0, 33) };
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [10, 10, 10]), open, cuboid([0, 0, 0], [20, 20, 20]));
    expect(execute(doc, 'minkowski_sum', { a: ids[0], b: ids[1], op: 'sum' }).error?.code).toBe('MESH_NOT_CLOSED');
    expect(execute(doc, 'minkowski_sum', { a: ids[1], b: ids[0], op: 'sum' }).error?.ids).toEqual([ids[1]]);
    expect(execute(doc, 'minkowski_sum', { a: ids[0], b: ids[0], op: 'sum' }).error?.code).toBe('MESH_PARAM_INVALID');
    expect(execute(doc, 'minkowski_sum', { a: ids[0], b: 'ghost', op: 'sum' }).error?.code).toBe('MESH_ENTITY_NOT_FOUND');
    expectNoOp(execute(doc, 'minkowski_sum', { a: ids[0], b: ids[2], op: 'difference' }), doc);
    expect(execute(doc, 'minkowski_sum', { a: ids[0], b: ids[2], op: 'difference' }).error?.code).toBe('MESH_PARAM_INVALID');
    setMeshProcessingEngine(null);
    try {
      const refused = execute(doc, 'minkowski_sum', { a: ids[0], b: ids[0] === ids[2] ? ids[1] : ids[2], op: 'difference' });
      expect(refused.error?.code).toBe('MESH_ENGINE_UNSUPPORTED');
      expect(refused.error?.remediation).toContain('Manifold');
    } finally {
      setMeshProcessingEngine(manifold);
    }
  });

  it('is pure', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [2, 2, 2]), cuboid([0, 0, 0], [1, 1, 1]));
    expectPure(doc, () => execute(doc, 'minkowski_sum', { a: ids[0], b: ids[1], op: 'sum' }));
  });
});

describe('offset_mesh, hollow_mesh (VC-MSH-15, 16)', () => {
  const SPHERE = icosphere(10, 5);
  const bound = (data: Data, slack = 0): number => (data['area'] as number) * 0.01 + slack;

  it.each([
    ['sphere +1', 1, 5575.27976257],
    ['sphere -1', -1, 3053.62805929],
  ])('%s: volume within area x 0.01 of the parallel body', (_, distance, expected) => {
    const { doc, ids } = docWithMeshes(SPHERE);
    const result = execute(doc, 'offset_mesh', { id: ids[0], distance, tolerance: 0.01, maxCells: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([ids[0]]);
    const data = dataOf(result);
    expect(Math.abs((data['volume'] as number) - expected)).toBeLessThanOrEqual(bound(data));
    expect(data).toMatchObject({ method: 'level_set', closed: true, unit: 'mm' });
    // the cell cap coarsens the grid: the result says so and reports the bound it really has (area x edge), which holds
    expect(data['toleranceMet']).toBe(false);
    expect(data['errorBound']).toBeCloseTo((data['area'] as number) * (data['edgeLength'] as number), 9);
    expect(Math.abs((data['volume'] as number) - expected)).toBeLessThanOrEqual(data['errorBound'] as number);
    expect(data['provenance']).toMatchObject({ engine: 'manifold' });
    expect(data['defaults']).toEqual([]);
  });

  it('cube -1 stays sharp: (a - 2d)^3 = 512, tolerance met, within the rigorous bound area x tolerance', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [10, 10, 10]));
    const shrunk = execute(doc, 'offset_mesh', { id: ids[0], distance: -1, tolerance: 0.15, maxCells: 700_000 });
    const data = dataOf(shrunk);
    expect(data['toleranceMet']).toBe(true);
    expect(data['edgeLength']).toBeCloseTo(0.15, 12);
    expect(Math.abs((data['volume'] as number) - 512)).toBeLessThanOrEqual(data['errorBound'] as number);
    expect(Math.abs((data['volume'] as number) - 512)).toBeLessThan(1);
    expect(data['errorBound']).toBeCloseTo((data['area'] as number) * 0.15, 9);
  });

  it('cube +1 rounds the corners (1698.4366) and keepSource keeps the cube', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [10, 10, 10]));
    const grown = execute(doc, 'offset_mesh', { id: ids[0], distance: 1, tolerance: 0.3, maxCells: 100_000, keepSource: true });
    expect(grown.document.order).toEqual([ids[0], grown.affected[0]]);
    expect(Math.abs((dataOf(grown)['volume'] as number) - 1698.43656981)).toBeLessThan(3);
  });

  it('uses the named default tolerance when none is given and moves vertices along normals with method normal (TypeScript engine)', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 2));
    const level = execute(doc, 'offset_mesh', { id: ids[0], distance: 0.5 });
    expect(dataOf(level)['defaults']).toEqual([expect.objectContaining({ name: 'tolerance', defaulted: true })]);
    const normal = execute(doc, 'offset_mesh', { id: ids[0], distance: 1, method: 'normal' });
    expect(dataOf(normal)['provenance']).toMatchObject({ engine: 'ts' });
    expect(dataOf(normal)['selfIntersectionsCreated']).toBe(0);
    expect(relativeError(dataOf(normal)['volume'] as number, (4 / 3) * Math.PI * 11 ** 3)).toBeLessThan(0.04);
  });

  it('hollows a sphere with wall 1 to a sealed cavity: 1135.16 within area x 0.01', () => {
    const { doc, ids } = docWithMeshes(SPHERE);
    const result = execute(doc, 'hollow_mesh', { id: ids[0], wallThickness: 1, tolerance: 0.01, maxCells: 30_000 });
    expect(result.error).toBeUndefined();
    const data = dataOf(result);
    expect(Math.abs((data['materialVolume'] as number) - 1135.1621455)).toBeLessThanOrEqual(bound(data));
    expect(data['cavityVolume'] as number).toBeGreaterThan(2900);
    expect(data).toMatchObject({ closed: true, wallThickness: 1 });
    const analysis = execute(result.document, 'analyze_mesh', { id: ids[0] });
    expect(dataOf(analysis)['shellCount']).toBe(2);
  });

  it('refuses unknown ids, zero distance, open meshes, too thick walls and grids above maxCells', () => {
    const open = cuboid([0, 0, 0], [1, 1, 1]);
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [10, 10, 10]), { positions: open.positions, indices: open.indices.slice(0, 33) });
    const code = (name: string, params: Record<string, unknown>): string | undefined => {
      const result = execute(doc, name, params);
      expectNoOp(result, doc);
      return result.error?.code;
    };
    expect(code('offset_mesh', { id: 'ghost', distance: 1 })).toBe('MESH_ENTITY_NOT_FOUND');
    expect(code('offset_mesh', { id: ids[0], distance: 0 })).toBe('MESH_PARAM_INVALID');
    expect(code('offset_mesh', { id: ids[1], distance: 1 })).toBe('MESH_NOT_CLOSED');
    expect(code('offset_mesh', { id: ids[0], distance: 1, tolerance: 1e-6, maxCells: 8 })).toBe('MESH_OFFSET_RESOLUTION');
    expect(code('hollow_mesh', { id: ids[1], wallThickness: 0.1 })).toBe('MESH_NOT_CLOSED');
    expect(code('hollow_mesh', { id: ids[0], wallThickness: 50 })).toBe('MESH_PARAM_INVALID');
    expect(code('offset_mesh', { id: ids[0], distance: -6 })).toBe('MESH_PARAM_INVALID');
    setMeshProcessingEngine(null);
    try {
      expect(code('offset_mesh', { id: ids[0], distance: 1 })).toBe('MESH_ENGINE_UNSUPPORTED');
      expect(code('hollow_mesh', { id: ids[0], wallThickness: 1 })).toBe('MESH_ENGINE_UNSUPPORTED');
    } finally {
      setMeshProcessingEngine(manifold);
    }
  });

  it('are pure', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [4, 4, 4]));
    expectPure(doc, () => execute(doc, 'offset_mesh', { id: ids[0], distance: 0.5, tolerance: 0.05 }));
    expectPure(doc, () => execute(doc, 'hollow_mesh', { id: ids[0], wallThickness: 0.5, tolerance: 0.05 }));
  });
});

describe('repair_mesh mode wrap (VC-MSH-35)', () => {
  it('rebuilds two overlapping sphere soups R 10, centres 10 apart, into one closed manifold of the lens-union volume', () => {
    const a = icosphere(10, 5);
    const b = icosphere(10, 5, [10, 0, 0]);
    const count = a.positions.length / 3;
    const { doc, ids } = docWithMeshes({
      positions: [...a.positions, ...b.positions],
      indices: [...a.indices, ...b.indices.map((i) => i + count)],
    });
    const before = execute(doc, 'analyze_mesh', { id: ids[0] });
    expect(dataOf(before)['selfIntersectionPairs'] as number).toBeGreaterThan(0);
    const result = execute(doc, 'repair_mesh', { id: ids[0], mode: 'wrap', tolerance: 0.01, maxCells: 30_000 });
    expect(result.error).toBeUndefined();
    const data = dataOf(result);
    expect(data).toMatchObject({ closed: true, innerStructuresDestroyed: true, selfIntersectionsAfter: 0, mode: 'wrap' });
    expect(Math.abs((data['volume'] as number) - 7068.58347058)).toBeLessThanOrEqual(18.8495559215);
    expect(Math.abs((data['area'] as number) - 1884.95559215)).toBeLessThan(25);
    const entity = result.document.entities[ids[0] as string] as MeshSolidEntity;
    expect(entity.meshSource).toMatchObject({ format: 'generated', verified: false });
  });

  it('refuses unknown ids and a missing engine, and is pure', () => {
    const { doc, ids } = docWithMeshes(cuboid([0, 0, 0], [1, 1, 1]));
    expect(execute(doc, 'repair_mesh', { id: 'ghost', mode: 'wrap' }).error?.code).toBe('MESH_ENTITY_NOT_FOUND');
    expect(execute(doc, 'repair_mesh', { id: ids[0], mode: 'polish' }).error?.code).toBe('CMD_INVALID_PARAMS');
    setMeshProcessingEngine(null);
    try {
      expectNoOp(execute(doc, 'repair_mesh', { id: ids[0], mode: 'wrap' }), doc);
    } finally {
      setMeshProcessingEngine(manifold);
    }
    expectPure(doc, () => execute(doc, 'repair_mesh', { id: ids[0], mode: 'wrap', tolerance: 0.05 }));
  });
});

describe('subdivide_mesh (VC-MSH-36)', () => {
  it('midpoint on the icosahedron: 80 faces, area and volume unchanged (1e-12)', () => {
    const { doc, ids } = docWithMeshes(icosahedron());
    const result = execute(doc, 'subdivide_mesh', { id: ids[0], method: 'midpoint', levels: 1 });
    const data = dataOf(result);
    expect(data['faces']).toBe(80);
    expect(relativeError(data['area'] as number, 34.6410161514)).toBeLessThan(1e-12);
    expect(relativeError(data['volume'] as number, 17.453559925)).toBeLessThan(1e-12);
    expect(result.affected).toEqual([ids[0]]);
  });

  it('loop quadruples the faces per level; smooth uses Manifold and stays closed', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 1));
    const loop = execute(doc, 'subdivide_mesh', { id: ids[0], method: 'loop', levels: 2, keepSource: true });
    expect(dataOf(loop)['faces']).toBe(80 * 16);
    expect(loop.document.order).toHaveLength(2);
    const smooth = execute(doc, 'subdivide_mesh', { id: ids[0], method: 'smooth', levels: 1, featureAngleDeg: 60 });
    expect(smooth.error).toBeUndefined();
    expect(dataOf(smooth)).toMatchObject({ closed: true, provenance: expect.objectContaining({ engine: 'manifold' }) });
    expect(dataOf(smooth)['faces'] as number).toBeGreaterThan(80);
    const byLength = execute(doc, 'subdivide_mesh', { id: ids[0], method: 'smooth', maxEdgeLength: 2 });
    expect(dataOf(byLength)['faces'] as number).toBeGreaterThan(80);
  });

  it('refuses unknown ids, oversize results, smooth on an open mesh and smooth without Manifold', () => {
    const open = cuboid([0, 0, 0], [1, 1, 1]);
    const { doc, ids } = docWithMeshes(icosphere(10, 4), { positions: open.positions, indices: open.indices.slice(0, 33) });
    expect(execute(doc, 'subdivide_mesh', { id: 'ghost', method: 'midpoint' }).error?.code).toBe('MESH_ENTITY_NOT_FOUND');
    expect(execute(doc, 'subdivide_mesh', { id: ids[0], method: 'midpoint', levels: 6 }).error?.code).toBe('MESH_PARAM_INVALID');
    expect(execute(doc, 'subdivide_mesh', { id: ids[1], method: 'smooth' }).error?.code).toBe('MESH_NON_MANIFOLD');
    setMeshProcessingEngine(null);
    try {
      expect(execute(doc, 'subdivide_mesh', { id: ids[0], method: 'smooth' }).error?.code).toBe('MESH_ENGINE_UNSUPPORTED');
    } finally {
      setMeshProcessingEngine(manifold);
    }
    expectPure(doc, () => execute(doc, 'subdivide_mesh', { id: ids[1], method: 'midpoint' }));
  });
});

describe('boolean routing (VC-MSH-18, D4)', () => {
  const cubes = (): ReturnType<typeof docWithMeshes> => docWithMeshes(cuboid([0, 0, 0], [2, 2, 2]), cuboid([1, 1, 1], [3, 3, 3]));

  it.each([
    ['union', 15, 42],
    ['subtract', 7, 24],
    ['intersect', 1, 6],
  ] as const)('%s of two triangle-only cubes goes to the mesh engine: volume %i, area %i, no brep', (op, volume, area) => {
    const { doc, ids } = cubes();
    const result = execute(doc, 'boolean', { op, a: ids[0], b: ids[1] });
    expect(result.error).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    const entity = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(entity.brep).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ engine: 'manifold', unverified: true });
    expect(relativeError(dataOf(result)['volume'] as number, volume)).toBeLessThan(1e-12);
    expect(relativeError(dataOf(result)['area'] as number, area)).toBeLessThan(1e-12);
    expect(result.summary).toContain('mesh engine');
  });

  it('takes several tools and engine "mesh" accepts primitives; engine "kernel" and primitives keep the B-rep path', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [4, 4, 4], anchor: 'min' }).document;
    doc = execute(doc, 'add_box', { size: [1, 1, 1], position: [1, 1, 1], anchor: 'min' }).document;
    doc = execute(doc, 'add_box', { size: [1, 1, 1], position: [2, 2, 2], anchor: 'min' }).document;
    const [a, b, c] = doc.order as [string, string, string];
    const viaMesh = execute(doc, 'boolean', { op: 'subtract', a, b: [b, c], engine: 'mesh' });
    expect(viaMesh.error).toBeUndefined();
    expect(dataOf(viaMesh)['unverified']).toBe(false);
    expect(dataOf(viaMesh)['volume'] as number).toBeCloseTo(62, 5);
    const viaKernel = execute(doc, 'boolean', { op: 'union', a, b, engine: 'kernel' });
    expect(viaKernel.data).toBeUndefined();
    expect((viaKernel.document.entities[viaKernel.affected[0] as string] as MeshSolidEntity).brep).toBeDefined();
    const auto = execute(doc, 'boolean', { op: 'union', a, b });
    expect((auto.document.entities[auto.affected[0] as string] as MeshSolidEntity).brep).toBeDefined();
  });

  it('consuming the operands cleans selection, groups and order like the kernel path', () => {
    const base = cubes();
    let doc = execute(base.doc, 'add_box', { size: [1, 1, 1] }).document;
    const ids = base.ids as [string, string];
    const keep = doc.order[2] as string;
    doc = execute(doc, 'group_entities', { ids: [ids[0], ids[1], keep] }).document;
    doc = { ...doc, selection: [ids[0], ids[1], keep] };
    const result = execute(doc, 'boolean', { op: 'union', a: ids[0], b: ids[1] });
    expect(result.error).toBeUndefined();
    expect(result.document.selection).toEqual([keep]);
    expect(result.document.order).toEqual([keep, result.affected[0]]);
    expect(JSON.stringify(result.document.groups)).not.toContain(ids[0]);
    const hull = execute(doc, 'convex_hull', { ids: [ids[0]], keepSources: false });
    expect(hull.document.selection).toEqual([ids[1], keep]);
    expect(hull.document.entities[ids[0]]).toBeUndefined();
  });

  it('refuses non-manifold operands and empty results, leaving the document unchanged', () => {
    const open = cuboid([0, 0, 0], [1, 1, 1]);
    const { doc, ids } = docWithMeshes(
      { positions: open.positions, indices: open.indices.slice(0, 33) },
      cuboid([0, 0, 0], [2, 2, 2]),
      cuboid([5, 5, 5], [6, 6, 6]),
    );
    const broken = execute(doc, 'boolean', { op: 'union', a: ids[0], b: ids[1] });
    expectNoOp(broken, doc);
    expect(broken.error?.code).toBe('MESH_NON_MANIFOLD');
    expect(broken.error?.remediation).toContain('wrap');
    const disjoint = execute(doc, 'boolean', { op: 'intersect', a: ids[1], b: ids[2] });
    expectNoOp(disjoint, doc);
    expect(disjoint.error?.code).toBe('MESH_BOOLEAN_FAILED');
    expect(execute(doc, 'boolean', { op: 'union', a: ids[1], b: 'ghost', engine: 'mesh' }).error).toBeUndefined();
    expectPure(doc, () => execute(doc, 'boolean', { op: 'union', a: ids[1], b: ids[2] }));
  });

  it('is kernel-optional: the mesh path needs no kernel, the kernel path refuses without one', async () => {
    const { doc, ids } = cubes();
    const kernel = await createManifoldKernel();
    setGeometryKernel(null);
    try {
      const meshPath = execute(doc, 'boolean', { op: 'union', a: ids[0], b: ids[1] });
      expect(meshPath.error).toBeUndefined();
      expect(relativeError(dataOf(meshPath)['volume'] as number, 15)).toBeLessThan(1e-12);
      let primitives = createEmptyDocument();
      primitives = execute(primitives, 'add_box', { size: [2, 2, 2] }).document;
      primitives = execute(primitives, 'add_box', { size: [2, 2, 2], position: [1, 0, 0] }).document;
      const [a, b] = primitives.order as [string, string];
      expectNoOp(execute(primitives, 'boolean', { op: 'union', a, b }), primitives, 'kernel');
      expect(execute(primitives, 'boolean', { op: 'union', a, b, engine: 'mesh' }).error).toBeUndefined();
    } finally {
      setGeometryKernel(kernel);
    }
  });

  it('decides "auto" from the operands alone: triangle-only operands without a mesh engine refuse on every host', () => {
    const { doc, ids } = cubes();
    setMeshProcessingEngine(null);
    try {
      const refused = execute(doc, 'boolean', { op: 'union', a: ids[0], b: ids[1] });
      expectNoOp(refused, doc);
      expect(refused.error?.code).toBe('MESH_ENGINE_UNSUPPORTED');
      expect(execute(doc, 'boolean', { op: 'union', a: ids[0], b: ids[1], engine: 'mesh' }).error?.code).toBe('MESH_ENGINE_UNSUPPORTED');
      const withKernel = execute(doc, 'boolean', { op: 'union', a: ids[0], b: ids[1], engine: 'kernel' });
      expect(withKernel.error).toBeUndefined();
      expect((withKernel.document.entities[withKernel.affected[0] as string] as MeshSolidEntity).brep).toBeDefined();
    } finally {
      setMeshProcessingEngine(manifold);
    }
  });
});

describe('engine composition', () => {
  it('asks engines in order, falls through on UNSUPPORTED and reports caps and unsupported ops', () => {
    const capped: MeshProcessingEngine = {
      name: 'tiny',
      capabilities: () => new Map([['hull', 3]]),
      run: () => ({ code: 'MESH_ENGINE_UNSUPPORTED', message: 'no' }),
    };
    const engine = composeMeshEngines([capped, resolveMeshEngine(null)]);
    expect(engine.name).toBe('tiny+ts');
    expect(engine.capabilities().has('analyze')).toBe(true);
    const mesh = { positions: cuboid([0, 0, 0], [1, 1, 1]).positions, indices: cuboid([0, 0, 0], [1, 1, 1]).indices };
    expect(engine.run({ mesh }, { op: 'hull', points: mesh.positions })).toMatchObject({ mesh: expect.anything() });
    expect(composeMeshEngines([capped]).run({ mesh }, { op: 'hull', points: mesh.positions })).toMatchObject({
      code: 'MESH_ENGINE_CAP_EXCEEDED',
    });
    expect(resolveMeshEngine(null).run({ mesh }, { op: 'wrap', tolerance: 1, maxCells: 1 })).toMatchObject({
      code: 'MESH_ENGINE_UNSUPPORTED',
    });
  });
});
