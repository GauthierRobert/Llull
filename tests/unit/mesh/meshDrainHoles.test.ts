/** 07 MSH M1 leftovers of M2: hollow_mesh drainHoles (FR-MSH-15, US-5) on the Manifold mesh engine; and the cut of a hollowed print part. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { drainTool } from '@core/geometry/mesh/drainHole';
import { fastMeasure } from '@core/geometry/mesh/fastMeasure';
import { SurfaceIndex } from '@core/geometry/mesh/surfaceIndex';
import { createManifoldMeshEngine } from '@kernel-manifold/manifoldMeshEngine';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { cuboid, docWithMeshes, icosphere } from '../../helpers/meshFixtures';

beforeAll(async () => {
  setMeshProcessingEngine(await createManifoldMeshEngine());
});
afterAll(() => setMeshProcessingEngine(null));

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;

describe('hollow_mesh drainHoles', () => {
  it('opens the cavity of a hollowed sphere through a drain at the bottom: one shell, the hole volume removed from the wall', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const id = ids[0] as string;
    const sealed = execute(doc, 'hollow_mesh', { id, wallThickness: 1, tolerance: 0.5, maxCells: 60_000 });
    expect(sealed.error).toBeUndefined();
    expect(dataOf(sealed)['drainHoles']).toBeUndefined();
    const drained = execute(doc, 'hollow_mesh', {
      id,
      wallThickness: 1,
      tolerance: 0.5,
      maxCells: 60_000,
      drainHoles: [{ near: [0, 0, -10], diameter: 3 }],
    });
    expect(drained.error).toBeUndefined();
    const data = dataOf(drained);
    expect(data['cavityOpen']).toBe(true);
    const holes = data['drainHoles'] as Array<{ at: number[]; normal: number[]; distance: number; diameter: number }>;
    expect(holes).toHaveLength(1);
    expect(holes[0]?.diameter).toBe(3);
    expect(holes[0]?.normal[2]).toBeLessThan(-0.9);
    expect(holes[0]?.distance).toBeLessThan(0.5);
    const removed = (dataOf(sealed)['volume'] as number) - (data['volume'] as number);
    expect(removed).toBeGreaterThan(4);
    expect(removed).toBeLessThan(12);
    const shells = dataOf(execute(drained.document, 'analyze_mesh', { id, selfIntersections: false }))['shellCount'];
    expect(shells).toBe(1);
    expect(dataOf(execute(sealed.document, 'analyze_mesh', { id, selfIntersections: false }))['shellCount']).toBe(2);
  });

  it('two holes remove about twice as much; a hole away from the surface still sits on the nearest surface point', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 4));
    const id = ids[0] as string;
    const one = execute(doc, 'hollow_mesh', {
      id,
      wallThickness: 1,
      tolerance: 0.5,
      maxCells: 60_000,
      drainHoles: [{ near: [0, 0, -10], diameter: 2 }],
    });
    const two = execute(doc, 'hollow_mesh', {
      id,
      wallThickness: 1,
      tolerance: 0.5,
      maxCells: 60_000,
      drainHoles: [
        { near: [0, 0, -10], diameter: 2 },
        { near: [0, 0, 14], diameter: 2 },
      ],
    });
    const second = (dataOf(two)['drainHoles'] as Array<{ at: number[]; distance: number }>)[1];
    expect(second?.at[2]).toBeGreaterThan(9.5);
    expect(second?.distance).toBeGreaterThan(3.5);
    expect(dataOf(two)['volume'] as number).toBeLessThan(dataOf(one)['volume'] as number);
  });

  it('is pure and still refuses an open mesh', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 2));
    const id = ids[0] as string;
    expectPure(doc, () => execute(doc, 'hollow_mesh', { id, wallThickness: 1, drainHoles: [{ near: [0, 0, -10], diameter: 3 }] }));
    const open = docWithMeshes({ positions: icosphere(10, 2).positions, indices: icosphere(10, 2).indices.slice(3) });
    const refused = execute(open.doc, 'hollow_mesh', {
      id: open.ids[0] as string,
      wallThickness: 1,
      drainHoles: [{ near: [0, 0, -10], diameter: 3 }],
    });
    expectNoOp(refused, open.doc);
    expect(refused.error?.code).toBe('MESH_NOT_CLOSED');
  });
});

describe('drain tool', () => {
  it('builds a closed cylinder 3 x the wall long along the outward normal, and is null for an empty surface', () => {
    const box = cuboid([0, 0, 0], [10, 10, 10]);
    const index = new SurfaceIndex(box.positions, box.indices);
    const tool = drainTool(box, index, [5, 5, -3], 4, 1);
    expect(tool).not.toBeNull();
    expect(tool?.normal).toEqual([0, 0, -1]);
    expect(tool?.at).toEqual([5, 5, 0]);
    expect(tool?.distance).toBe(3);
    const zs = tool?.mesh.positions.filter((_, i) => i % 3 === 2) ?? [];
    expect(Math.min(...zs)).toBeCloseTo(-1.5, 12);
    expect(Math.max(...zs)).toBeCloseTo(1.5, 12);
    expect(drainTool({ positions: [], indices: [] }, new SurfaceIndex([], []), [0, 0, 0], 1, 1)).toBeNull();
    const along = drainTool(box, index, [-3, 5, 5], 2, 1);
    expect(along?.normal).toEqual([-1, 0, 0]);
    const x = drainTool(box, index, [5, -3, 5], 2, 1);
    expect(x?.normal[1]).toBe(-1);
  });

  it('builds an outward-wound closed tool for every surface orientation (sphere points in all directions)', () => {
    const sphere = icosphere(10, 2);
    const index = new SurfaceIndex(sphere.positions, sphere.indices);
    for (let k = 0; k < 40; k++) {
      const t = Math.acos(1 - (2 * (k + 0.5)) / 40);
      const p = k * 2.399963229728653;
      const near: [number, number, number] = [14 * Math.sin(t) * Math.cos(p), 14 * Math.sin(t) * Math.sin(p), 14 * Math.cos(t)];
      const tool = drainTool(sphere, index, near, 2, 1);
      expect(fastMeasure(tool?.mesh ?? { positions: [], indices: [] }).volume ?? 0).toBeGreaterThan(0);
    }
    expect(drainTool(sphere, index, [0, 0, 0], 2, 1)?.distance).toBeGreaterThan(8);
    const sliver = { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [0, 1, 2] };
    expect(drainTool(sliver, new SurfaceIndex(sliver.positions, sliver.indices), [1, 1, 0], 1, 1)?.normal).toEqual([0, 0, 0]);
  });
});
