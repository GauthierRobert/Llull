/** 07 MSH M6: fit_surface_to_mesh (pure TypeScript): analytic oracles on spherical caps and planes, grid growth, orientation, scale sweep, refusals, purity, replay. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { MeshAssetPort } from '@core/geometry/mesh/assets';
import { evaluateSurface, surfaceDerivatives } from '@core/lib/nurbs/surface';
import { type CadDocument, type MeshSolidEntity, type NurbsSurfaceEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { gridMesh, docWithMeshes, icosphere, type IndexedMesh } from '../../helpers/meshFixtures';

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;
const codeOf = (result: { error?: { code: string } }): string | undefined => result.error?.code;
const surfaceOf = (doc: CadDocument, id: string): NurbsSurfaceEntity['surface'] => (doc.entities[id] as NurbsSurfaceEntity).surface;
const normalAt = (doc: CadDocument, id: string, u: number, v: number): Vec3 => {
  const d = surfaceDerivatives(surfaceOf(doc, id), u, v, 1);
  const [du, dv] = [(d[1] as Vec3[])[0] as Vec3, (d[0] as Vec3[])[1] as Vec3];
  return [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
};

const cap = (radius: number): { doc: CadDocument; id: string; region: { center: Vec3; radius: number } } => {
  const { doc, ids } = docWithMeshes(icosphere(radius, 5));
  return { doc, id: ids[0] as string, region: { center: [0, 0, radius], radius: radius / 2 } };
};

const bump = (): { doc: CadDocument; id: string } => {
  const grid = execute(createEmptyDocument(), 'add_grid_mesh', { size: [20, 20], cells: [60, 60] });
  const id = grid.affected[0] as string;
  const sculpted = execute(grid.document, 'sculpt_mesh', {
    id,
    brush: 'draw',
    stamps: [{ center: [0, 0, 0] }],
    radius: 4,
    strength: 0.5,
    falloff: 'smooth',
    direction: 'normal',
  });
  expect(sculpted.error).toBeUndefined();
  return { doc: sculpted.document, id };
};

describe('fit_surface_to_mesh', () => {
  it('fits a spherical cap: within maxDeviation of the mesh and of the sphere R 10, normal outward', () => {
    const { doc, id, region } = cap(10);
    const result = execute(doc, 'fit_surface_to_mesh', { id, region, maxDeviation: 0.01 });
    expect(result.error, result.summary).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    const surfaceId = result.affected[0] as string;
    expect(surfaceId).toMatch(/^surf-/);
    expect(result.document.entities[surfaceId]?.kind).toBe('nurbs_surface');
    expect(result.document.order).toEqual([...doc.order, surfaceId]);
    const data = dataOf(result);
    expect(data).toMatchObject({ converged: true, degree: 3, sourceId: id, unit: 'mm', requestedMaxDeviation: 0.01 });
    expect(data['maxDeviation'] as number).toBeLessThanOrEqual(0.01);
    expect((data['rms'] as number) < (data['maxDeviation'] as number)).toBe(true);
    expect(data['gridsTried']).not.toEqual([]);
    // analytic oracle: the patch interior lies on the sphere (the mesh chords sit 0.005 inside)
    for (const u of [0.2, 0.35, 0.5, 0.65, 0.8])
      for (const v of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        const p = evaluateSurface(surfaceOf(result.document, surfaceId), u, v);
        expect(Math.abs(Math.hypot(...p) - 10)).toBeLessThan(0.015);
      }
    const normal = normalAt(result.document, surfaceId, 0.5, 0.5);
    const p = evaluateSurface(surfaceOf(result.document, surfaceId), 0.5, 0.5);
    expect(normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2]).toBeGreaterThan(0);
  });

  it('is scale-invariant: the relative deviation of a cap with a fixed 12 x 12 grid is the same at 1, 10, 100 and 1000 mm', () => {
    const relative: number[] = [];
    for (const radius of [0.5, 5, 50, 500]) {
      const { doc, id, region } = cap(radius);
      const result = execute(doc, 'fit_surface_to_mesh', { id, region, controlPoints: [12, 12] });
      expect(result.error, result.summary).toBeUndefined();
      relative.push((dataOf(result)['maxDeviation'] as number) / radius);
    }
    for (const value of relative) expect(Math.abs(value / (relative[0] as number) - 1)).toBeLessThan(1e-3);
    expect(relative[0] as number).toBeLessThan(0.002);
  });

  it('reproduces a plane exactly and orients u along the long side with the normal on the triangle side', () => {
    const grid = execute(createEmptyDocument(), 'add_grid_mesh', { size: [10, 30], cells: [10, 30] });
    const id = grid.affected[0] as string;
    const result = execute(grid.document, 'fit_surface_to_mesh', { id, controlPoints: [8, 4], degree: 3 });
    expect(result.error, result.summary).toBeUndefined();
    const surfaceId = result.affected[0] as string;
    const surface = surfaceOf(result.document, surfaceId);
    expect([surface.poles.length, (surface.poles[0] as Vec3[]).length]).toEqual([8, 4]);
    expect(dataOf(result)['maxDeviation'] as number).toBeLessThan(1e-9);
    for (const row of surface.poles) for (const pole of row) expect(Math.abs(pole[2])).toBeLessThan(1e-9);
    const spanU =
      Math.abs(((surface.poles[7] as Vec3[])[0] as Vec3)[0] - ((surface.poles[0] as Vec3[])[0] as Vec3)[0]) +
      Math.abs(((surface.poles[7] as Vec3[])[0] as Vec3)[1] - ((surface.poles[0] as Vec3[])[0] as Vec3)[1]);
    expect(spanU).toBeCloseTo(30, 6);
    const grid0 = grid.document.entities[id];
    expect(grid0?.kind).toBe('mesh');
    const normal = normalAt(result.document, surfaceId, 0.5, 0.5);
    const faceNormalZ = 1; // add_grid_mesh faces +Z
    expect(Math.sign(normal[2])).toBe(faceNormalZ);
  });

  it('grows the pole grid until maxDeviation is met on a sculpted bump', () => {
    const { doc, id } = bump();
    const result = execute(doc, 'fit_surface_to_mesh', { id, maxDeviation: 0.01 });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf(result);
    expect(data['maxDeviation'] as number).toBeLessThanOrEqual(0.01);
    expect((data['gridsTried'] as number[][]).length).toBeGreaterThan(1);
    expect(data['converged']).toBe(true);
    const peak = evaluateSurface(surfaceOf(result.document, result.affected[0] as string), 0.5, 0.5);
    expect(peak[2]).toBeGreaterThan(0.4);
    expect(peak[2]).toBeLessThan(0.55);
  });

  it('creates the surface and warns when maxDeviation is not reached with a fixed grid', () => {
    const { doc, id } = bump();
    const result = execute(doc, 'fit_surface_to_mesh', { id, controlPoints: [4, 4], maxDeviation: 1e-6 });
    expect(result.error).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    const data = dataOf(result);
    expect(data['converged']).toBe(false);
    expect((data['warnings'] as Array<{ code: string }>)[0]?.code).toBe('MESH_FIT_NOT_CONVERGED');
    expect(result.summary).toContain('NOT within');
  });

  it('is pure and replays to the same id and poles', () => {
    const { doc, id, region } = cap(10);
    const params = { id, region, controlPoints: [8, 8] };
    expectPure(doc, () => execute(doc, 'fit_surface_to_mesh', params));
    const a = execute(doc, 'fit_surface_to_mesh', params);
    const b = execute(doc, 'fit_surface_to_mesh', params);
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
    const replayed = execute(a.document, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(Object.keys(replayed.document.entities)).toEqual(Object.keys(a.document.entities));
    const surfaceId = a.affected[0] as string;
    expect(surfaceOf(replayed.document, surfaceId)).toEqual(surfaceOf(a.document, surfaceId));
  });

  it('refuses bad input without touching the document', () => {
    const { doc, id, region } = cap(10);
    const line = execute(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    const tri = docWithMeshes({ positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] });
    const sliver = docWithMeshes({ positions: [0, 0, 0, 10, 0, 0, 20, 0, 0], indices: [0, 1, 2] });
    const cases: Array<[CadDocument, Record<string, unknown>, string]> = [
      [tri.doc, { id: tri.ids[0] }, 'MESH_FIT_TOO_FEW_SAMPLES'],
      [sliver.doc, { id: sliver.ids[0] }, 'MESH_FIT_REGION_EMPTY'],
      [doc, { id: 'nope' }, 'MESH_ENTITY_NOT_FOUND'],
      [line.document, { id: line.affected[0] }, 'MESH_NOT_A_MESH'],
      [doc, { id, region: { center: [100, 100, 100], radius: 1 } }, 'MESH_FIT_REGION_EMPTY'],
      [doc, { id }, 'MESH_FIT_NOT_PROJECTABLE'],
      [doc, { id, region, controlPoints: [3, 8], degree: 3 }, 'MESH_PARAM_INVALID'],
      [doc, { id, region, controlPoints: [60, 60] }, 'MESH_FIT_TOO_FEW_SAMPLES'],
      [doc, { id, region, degree: 0 }, 'CMD_INVALID_PARAMS'],
      [doc, { id, region, maxDeviation: -1 }, 'CMD_INVALID_PARAMS'],
      [doc, { id, region: { center: [0, 0, 10], radius: 0 } }, 'CMD_INVALID_PARAMS'],
    ];
    for (const [base, params, code] of cases) {
      const result = execute(base, 'fit_surface_to_mesh', params);
      expectNoOp(result, base);
      expect(codeOf(result), JSON.stringify(params)).toBe(code);
    }
  });
});

/** A cap of the R 10 sphere whose polar angle reaches `degrees` (a region sphere centred at the pole is the cap of chord radius 20 sin(degrees / 2)). */
const capOf = (degrees: number): { doc: CadDocument; id: string; region: { center: Vec3; radius: number } } => {
  const { doc, ids } = docWithMeshes(icosphere(10, 5));
  return { doc, id: ids[0] as string, region: { center: [0, 0, 10], radius: 20 * Math.sin((degrees * Math.PI) / 360) } };
};

describe('fit_surface_to_mesh fold rule and caps', () => {
  it('brackets the 2 % fold rule: a 60 degree cap is fitted, a hemisphere is refused by projection with its folded percentage (auto uses the harmonic map: fitSurfaceHarmonic.test.ts)', () => {
    const sixty = capOf(60);
    const accepted = execute(sixty.doc, 'fit_surface_to_mesh', { id: sixty.id, region: sixty.region, controlPoints: [10, 10] });
    expect(accepted.error, accepted.summary).toBeUndefined();
    expect(dataOf(accepted)['foldedFraction'] as number).toBeLessThan(0.02);
    expect(dataOf(accepted)['maxDeviation'] as number).toBeLessThan(0.1);
    const hemisphere = capOf(90);
    const refused = execute(hemisphere.doc, 'fit_surface_to_mesh', {
      id: hemisphere.id,
      region: hemisphere.region,
      parameterization: 'projection',
    });
    expectNoOp(refused, hemisphere.doc);
    expect(codeOf(refused)).toBe('MESH_FIT_NOT_PROJECTABLE');
    expect(refused.summary).toMatch(/[0-9]+[.][0-9] %/);
  });

  it('caps the REGION, not the mesh: an asset-backed 205 000 triangle grid is refused whole and fitted inside a small region', () => {
    const big = gridMesh(20, 320);
    const stub = docWithMeshes(icosphere(1, 0));
    const stored = stub.doc.entities[stub.ids[0] as string] as MeshSolidEntity;
    const id = stored.id;
    const key = 'a'.repeat(64);
    const doc = {
      ...stub.doc,
      entities: {
        ...stub.doc.entities,
        [id]: {
          ...stored,
          asset: {
            key,
            triangles: big.indices.length / 3,
            vertices: big.positions.length / 3,
            bounds: { min: [0, 0, 0], max: [20, 20, 0] },
          },
        },
      },
    } as CadDocument;
    const meshAssets: MeshAssetPort = {
      manifest: () => null,
      readMesh: () => big,
      writeMesh: () => stored.asset as never,
      readFile: () => null,
    };
    const context = { ...defaultContext(), meshAssets };
    const whole = execute(doc, 'fit_surface_to_mesh', { id }, context);
    expectNoOp(whole, doc);
    expect(codeOf(whole)).toBe('MESH_FIT_TOO_LARGE');
    expect(whole.summary).toContain('pick a smaller region or decimate_mesh first');
    const part = execute(doc, 'fit_surface_to_mesh', { id, region: { center: [10, 10, 0], radius: 3 }, controlPoints: [6, 6] }, context);
    expect(part.error, part.summary).toBeUndefined();
    expect(dataOf(part)['maxDeviation'] as number).toBeLessThan(1e-9);
  });

  for (const [name, extremeFirst] of [
    ['the extreme vertex first', true],
    ['the extreme vertex second', false],
  ] as const) {
    it(`takes the parameter bounds from all region vertices, not from the strided fit vertices (${name})`, () => {
      const n = 129;
      const base = gridMesh(20, n);
      const id = (i: number, j: number): number => j * (n + 1) + i;
      const positions = [...base.positions, extremeFirst ? 23 : 21.5, 10, 0, extremeFirst ? 21.5 : 23, 10.2, 0];
      const first = base.positions.length / 3;
      const mesh: IndexedMesh = { positions, indices: [...base.indices, id(n, 64), first, id(n, 65), id(n, 65), first + 1, id(n, 66)] };
      const { doc, ids } = docWithMeshes(mesh);
      const result = execute(doc, 'fit_surface_to_mesh', { id: ids[0], controlPoints: [8, 8] });
      expect(result.error, result.summary).toBeUndefined();
      const data = dataOf(result);
      expect(data['fitVertices'] as number).toBeLessThanOrEqual(15_000);
      expect(data['maxDeviation'] as number, 'the whole mesh lies inside the patch').toBeLessThan(1e-6);
      const poles = surfaceOf(result.document, result.affected[0] as string).poles.flat();
      // the best-fit frame is turned a little by the two extra triangles, so the rectangle reaches a little past the extreme vertex
      const reach = Math.max(...poles.map((p) => p[0]));
      expect(reach).toBeGreaterThanOrEqual(23 - 1e-6);
      expect(reach).toBeLessThan(23.5);
    });
  }

  it('grows the grid until the samples run out, then stops with a warning and the best grid', () => {
    const grid = execute(createEmptyDocument(), 'add_grid_mesh', { size: [20, 20], cells: [20, 20] });
    const id = grid.affected[0] as string;
    const sculpted = execute(grid.document, 'sculpt_mesh', {
      id,
      brush: 'draw',
      stamps: [{ center: [0, 0, 0] }],
      radius: 4,
      strength: 1,
      falloff: 'smooth',
      direction: 'normal',
    });
    const result = execute(sculpted.document, 'fit_surface_to_mesh', {
      id,
      maxDeviation: 1e-12,
      name: 'bump',
      color: '#112233',
      layerId: '0',
    });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf(result);
    expect(data['gridsTried']).toEqual([
      [6, 6],
      [8, 8],
      [12, 12],
    ]);
    expect(data['converged']).toBe(false);
    expect((data['warnings'] as Array<{ code: string }>)[0]?.code).toBe('MESH_FIT_NOT_CONVERGED');
    const entity = result.document.entities[result.affected[0] as string];
    expect(entity).toMatchObject({ name: 'bump', color: '#112233' });
  });

  it('fits a bilinear patch with degree 1 and the smallest grid, and refuses a pole grid below degree + 1', () => {
    const grid = execute(createEmptyDocument(), 'add_grid_mesh', { size: [10, 10], cells: [4, 4] });
    const id = grid.affected[0] as string;
    const result = execute(grid.document, 'fit_surface_to_mesh', { id, degree: 1, controlPoints: [2, 2] });
    expect(result.error, result.summary).toBeUndefined();
    const surface = surfaceOf(result.document, result.affected[0] as string);
    expect([surface.degreeU, surface.poles.length]).toEqual([1, 2]);
    expect(dataOf(result)['maxDeviation'] as number).toBeLessThan(1e-9);
    const low = execute(grid.document, 'fit_surface_to_mesh', { id, degree: 3, controlPoints: [3, 3] });
    expect(codeOf(low)).toBe('MESH_PARAM_INVALID');
  });
});
