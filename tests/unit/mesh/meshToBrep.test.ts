/** 07 MSH M5: mesh_to_brep command logic over a scripted kernel (the exact builder itself is tested natively in server/tests/meshToBrep.test.ts). */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { MeshToBrepRequest, MeshToBrepResult } from '@core/geometry/kernelMeshBrep';
import type { MeshSolidEntity } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { fakeKernel } from '../../helpers/fakeKernel';
import { cuboid, docWithMeshes, icosphere, plateWithHole, torus } from '../../helpers/meshFixtures';

const REPORT = {
  valid: true,
  volume: 8,
  area: 24,
  freeEdges: 0,
  multipleEdges: 0,
  exactFaces: 6,
  facetedFaces: 0,
  exactChains: 12,
  polylineChains: 0,
  built: { plane: 6 },
  facetedGroups: [] as number[],
};

function scripted(answer: (request: MeshToBrepRequest) => MeshToBrepResult | null): {
  kernel: GeometryKernel;
  requests: MeshToBrepRequest[];
} {
  const base = fakeKernel();
  const requests: MeshToBrepRequest[] = [];
  const kernel: GeometryKernel = {
    ...base,
    evaluate: (recipe) => base.evaluate(recipe.op === 'brep' ? { op: 'solid', entity: { id: 'x', kind: 'box' } as never } : recipe),
    loadBlob: () => undefined,
    meshToBrep: (request) => {
      requests.push(request);
      return answer(request);
    },
  } as GeometryKernel;
  return { kernel, requests };
}

describe('mesh_to_brep', () => {
  const cube = docWithMeshes(cuboid([0, 0, 0], [2, 2, 2]));
  const id = cube.ids[0] as string;

  it('prismatic sends the fitted groups to the kernel and stores the returned solid as a blob recipe', () => {
    const { kernel, requests } = scripted(() => ({ ok: true, brep: 'CASCADE Topology V3', report: REPORT }));
    const result = execute(cube.doc, 'mesh_to_brep', { id, mode: 'prismatic' }, { ...defaultContext(), kernel });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([id]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.groups.map((group) => group.kind)).toEqual(Array(6).fill('plane'));
    const entity = result.document.entities[id] as MeshSolidEntity;
    expect(entity.brep?.op).toBe('brep');
    expect(Object.keys(result.document.blobs ?? {})).toHaveLength(1);
    expect(result.summary).toContain('6 plane');
    expect(result.data).toMatchObject({ mode: 'prismatic', exactFaces: 6, facetedGroups: [] });
  });

  it('keeps the source with keepSource and reports regions that stayed triangles', () => {
    const { kernel } = scripted(() => ({
      ok: true,
      brep: 'x',
      report: { ...REPORT, built: { plane: 5 }, facetedFaces: 2, facetedGroups: [0] },
    }));
    const result = execute(
      cube.doc,
      'mesh_to_brep',
      { id, mode: 'prismatic', keepSource: true, fitTolerance: 1e-6 },
      { ...defaultContext(), kernel },
    );
    expect(result.document.order).toHaveLength(2);
    expect(result.summary).toContain('1 region(s) stay triangles');
    expect((result.data as { warnings: Array<{ code: string }> }).warnings[0]?.code).toBe('MESH_BREP_GROUP_FACETED');
  });

  it('faceted converts one planar face per triangle on a kernel with the B-rep builder', () => {
    const { kernel } = scripted(() => null);
    const result = execute(cube.doc, 'mesh_to_brep', { id, mode: 'faceted' }, { ...defaultContext(), kernel });
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ mode: 'faceted', faces: { faceted: 12 } });
  });

  it('has a plate with a hole segmented into a cylinder group in the request', () => {
    const plate = docWithMeshes(plateWithHole());
    const { kernel, requests } = scripted(() => ({ ok: true, brep: 'x', report: { ...REPORT, built: { plane: 6, cylinder: 1 } } }));
    execute(
      plate.doc,
      'mesh_to_brep',
      { id: plate.ids[0] as string, mode: 'prismatic', fitTolerance: 1e-6 },
      { ...defaultContext(), kernel },
    );
    expect(requests[0]?.groups.map((group) => group.kind).sort()).toEqual([
      'cylinder',
      'plane',
      'plane',
      'plane',
      'plane',
      'plane',
      'plane',
    ]);
  });

  it('sends sphere regions as sphere groups and freeform regions as faceted ones', () => {
    const ball = docWithMeshes(icosphere(10, 2));
    const sphere = scripted(() => ({ ok: true, brep: 'x', report: { ...REPORT, built: { sphere: 1 } } }));
    execute(
      ball.doc,
      'mesh_to_brep',
      { id: ball.ids[0] as string, mode: 'prismatic', fitTolerance: 0.2 },
      { ...defaultContext(), kernel: sphere.kernel },
    );
    expect(sphere.requests[0]?.groups.map((group) => group.kind)).toEqual(['sphere']);
    const ring = docWithMeshes(torus(10, 3, 24, 12));
    const free = scripted(() => ({ ok: true, brep: 'x', report: { ...REPORT, built: {}, facetedFaces: 576, facetedGroups: [0] } }));
    const result = execute(
      ring.doc,
      'mesh_to_brep',
      { id: ring.ids[0] as string, mode: 'prismatic', featureAngleDeg: 80 },
      { ...defaultContext(), kernel: free.kernel },
    );
    expect(free.requests[0]?.groups.length).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  it('refuses when the kernel cannot evaluate the sewn solid', () => {
    const base = scripted(() => ({ ok: true, brep: 'x', report: REPORT }));
    const kernel = { ...base.kernel, evaluate: () => null } as GeometryKernel;
    const result = execute(cube.doc, 'mesh_to_brep', { id, mode: 'prismatic' }, { ...defaultContext(), kernel });
    expect(result.error?.code).toBe('MESH_BREP_SEW_FAILED');
    expectNoOp(result, cube.doc);
  });

  it('refuses with coded errors and leaves the document unchanged', () => {
    const { kernel } = scripted(() => null);
    const failing = execute(cube.doc, 'mesh_to_brep', { id, mode: 'prismatic' }, { ...defaultContext(), kernel });
    expectNoOp(failing, cube.doc);
    expect(failing.error?.code).toBe('MESH_BREP_SEW_FAILED');
    const invalid = scripted(() => ({ ok: true, brep: 'x', report: { ...REPORT, valid: false, freeEdges: 2 } }));
    expect(execute(cube.doc, 'mesh_to_brep', { id, mode: 'prismatic' }, { ...defaultContext(), kernel: invalid.kernel }).error?.code).toBe(
      'MESH_BREP_SEW_FAILED',
    );
    const tooMany = execute(cube.doc, 'mesh_to_brep', { id, mode: 'faceted', maxFaces: 4 }, { ...defaultContext(), kernel: fakeKernel() });
    expect(tooMany.error?.code).toBe('MESH_PARAM_INVALID');
    const noBuilder = execute(cube.doc, 'mesh_to_brep', { id, mode: 'prismatic' }, { ...defaultContext(), kernel: fakeKernel() });
    expect(noBuilder.error?.code).toBe('MESH_KERNEL_UNSUPPORTED');
    const manifoldShaped = execute(cube.doc, 'mesh_to_brep', { id, mode: 'faceted' }, { ...defaultContext(), kernel: fakeKernel() });
    expectNoOp(manifoldShaped, cube.doc);
    expect(manifoldShaped.error?.code).toBe('MESH_KERNEL_UNSUPPORTED');
    expect(
      execute(cube.doc, 'mesh_to_brep', { id, mode: 'faceted', maxFaces: 300_000 }, { ...defaultContext(), kernel: fakeKernel() }).error
        ?.code,
    ).toBe('CMD_INVALID_PARAMS');
    const open = docWithMeshes({
      positions: cuboid([0, 0, 0], [1, 1, 1]).positions,
      indices: cuboid([0, 0, 0], [1, 1, 1]).indices.slice(3),
    });
    expect(
      execute(open.doc, 'mesh_to_brep', { id: open.ids[0] as string, mode: 'faceted' }, { ...defaultContext(), kernel: fakeKernel() }).error
        ?.code,
    ).toBe('MESH_NOT_CLOSED');
    expect(
      execute(cube.doc, 'mesh_to_brep', { id: 'nope', mode: 'faceted' }, { ...defaultContext(), kernel: fakeKernel() }).error?.code,
    ).toBe('MESH_ENTITY_NOT_FOUND');
    expect(execute(cube.doc, 'mesh_to_brep', { id, mode: 'weird' }, { ...defaultContext(), kernel: fakeKernel() }).error?.code).toBe(
      'CMD_INVALID_PARAMS',
    );
  });

  it('is pure', () => {
    const { kernel } = scripted(() => ({ ok: true, brep: 'x', report: REPORT }));
    expectPure(cube.doc, () => execute(cube.doc, 'mesh_to_brep', { id, mode: 'prismatic' }, { ...defaultContext(), kernel }));
  });
});
