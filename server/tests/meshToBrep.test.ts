/**
 * 07 MSH M5 on the native OCCT kernel: `mesh_to_brep` faceted (VC-MSH-24) and prismatic (VC-MSH-23: a plate with a tessellated hole becomes
 * 6 planes and a cylinder of radius 5, volume 5607.3009183). Skipped when the llull-kernel binary is not built or lacks `meshToBrep`.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { cuboid, docWithMeshes, icosphere, plateWithHole, relativeError } from '../../tests/helpers/meshFixtures';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;

describeNativeWhen({ capabilities: ['meshToBrep'], label: 'mesh_to_brep' })('mesh_to_brep on the native OCCT kernel', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const volumeOf = (doc: CadDocument, id: string): { volume: number; method: unknown } =>
    execute(doc, 'mass_properties', { entityId: id }).data as { volume: number; method: unknown };

  it('VC-MSH-24 faceted: the l2 icosphere becomes 320 planar faces with the exact polyhedral volume', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 2));
    const result = execute(doc, 'mesh_to_brep', { id: ids[0] as string, mode: 'faceted' });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([ids[0]]);
    const data = dataOf(result);
    expect(data['faces']).toEqual({ faceted: 320 });
    expect(data['brepFaces']).toBe(320);
    expect(relativeError(data['volumeExact'] as number, 4047.04467998)).toBeLessThan(1e-9);
    const entity = result.document.entities[ids[0] as string] as MeshSolidEntity;
    expect(entity.brep).toBeDefined();
    expect(volumeOf(result.document, ids[0] as string).method).toBe('exact');
  });

  it('VC-MSH-23 prismatic: the plate with a hole is 6 planes and 1 cylinder of radius 5, volume 5607.3009183', () => {
    const { doc, ids } = docWithMeshes(plateWithHole());
    const id = ids[0] as string;
    const result = execute(doc, 'mesh_to_brep', { id, mode: 'prismatic', fitTolerance: 1e-6 });
    expect(result.error).toBeUndefined();
    const data = dataOf(result);
    expect(data['faces']).toMatchObject({ plane: 6, cylinder: 1, faceted: 0 });
    expect(data['facetedGroups']).toEqual([]);
    expect(data['brepFaces']).toBe(7);
    const exact = 40 * 30 * 5 - Math.PI * 25 * 5;
    expect(exact).toBeCloseTo(5607.3009183, 6);
    expect(relativeError(data['volumeExact'] as number, exact)).toBeLessThan(1e-9);
    expect(data['maxResidual'] as number).toBeLessThan(1e-9);
    const entity = result.document.entities[id] as MeshSolidEntity;
    expect(entity.brep?.op).toBe('brep');
    expect(Object.keys(result.document.blobs ?? {})).toHaveLength(1);
    const faces = (execute(result.document, 'inspect_topology', { id }).data as { faces: Array<{ surface?: string; type?: string }> })
      .faces;
    expect(faces).toHaveLength(7);
    expect(volumeOf(result.document, id).method).toBe('exact');
  });

  it('refuses an open mesh, a mesh over maxFaces, and keeps the source with keepSource', () => {
    const sphere = icosphere(10, 2);
    const open = docWithMeshes({ positions: sphere.positions, indices: sphere.indices.slice(3) });
    expect(execute(open.doc, 'mesh_to_brep', { id: open.ids[0] as string, mode: 'faceted' }).error?.code).toBe('MESH_NOT_CLOSED');
    const closed = docWithMeshes(cuboid([0, 0, 0], [2, 2, 2]));
    expect(execute(closed.doc, 'mesh_to_brep', { id: closed.ids[0] as string, mode: 'faceted', maxFaces: 6 }).error?.code).toBe(
      'MESH_PARAM_INVALID',
    );
    const kept = execute(closed.doc, 'mesh_to_brep', { id: closed.ids[0] as string, mode: 'prismatic', keepSource: true });
    expect(kept.error).toBeUndefined();
    expect(kept.document.order).toHaveLength(2);
    expect(dataOf(kept)['faces']).toMatchObject({ plane: 6 });
    expect(execute(createEmptyDocument(), 'mesh_to_brep', { id: 'nope', mode: 'faceted' }).error?.code).toBe('MESH_ENTITY_NOT_FOUND');
  });
});
