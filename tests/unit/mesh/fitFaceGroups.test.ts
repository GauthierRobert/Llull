/** 07 MSH M6 leftovers (TECHNICAL_SPEC 13.24): the `faceGroups` region of fit_surface_to_mesh and fit_subdivision_to_mesh: stored groups, segment_mesh regions, validation by name. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { limitSurfaceMesh } from '@core/geometry/subd/fitOperator';
import { type CadDocument, type MeshSolidEntity, type NurbsSurfaceEntity, type SubdivisionEntity, type Vec3 } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { docWithMeshes, gridMesh, icosphere, type IndexedMesh } from '../../helpers/meshFixtures';
import { quadSphere } from '../../helpers/quadFixtures';

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;
const codeOf = (result: { error?: { code: string } }): string | undefined => result.error?.code;
const polesOf = (doc: CadDocument, id: string): Vec3[] => (doc.entities[id] as NurbsSurfaceEntity).surface.poles.flat();

/** Two plates side by side: x in [0, 10] at z = 0 (triangles 0 to 127) and x in [20, 30] at z = 3 (128 to 255). */
function twoPlates(): IndexedMesh {
  const left = gridMesh(10, 8);
  const right = gridMesh(10, 8);
  const offset = left.positions.length / 3;
  return {
    positions: [...left.positions, ...right.positions.map((v, i) => (i % 3 === 0 ? v + 20 : i % 3 === 2 ? 3 : v))],
    indices: [...left.indices, ...right.indices.map((i) => i + offset)],
  };
}

/** `mesh` with stored face groups (`[start, end)` triangle ranges, as an import writes them). */
function withGroups(mesh: IndexedMesh, groups: Record<string, Array<[number, number]>>): { doc: CadDocument; id: string } {
  const { doc, ids } = docWithMeshes(mesh);
  const id = ids[0] as string;
  const entity = doc.entities[id] as MeshSolidEntity;
  const faceGroups = Object.entries(groups).map(([name, faces]) => ({ id: name, faces }));
  return { doc: { ...doc, entities: { ...doc.entities, [id]: { ...entity, faceGroups } } }, id };
}

/** An inner corner: a floor (x and y in [0, 10], z = 0) and a wall (x = 10, y in [0, 10], z in [0, 10]) sharing the edge x = 10, z = 0, consistently wound; welded on load. */
function corner(): IndexedMesh {
  const floor = gridMesh(10, 8);
  const wall = gridMesh(10, 8);
  const offset = floor.positions.length / 3;
  const positions = [...floor.positions];
  for (let v = 0; v < wall.positions.length; v += 3) positions.push(10, wall.positions[v] as number, wall.positions[v + 1] as number);
  const indices = [...floor.indices];
  for (let t = 0; t < wall.indices.length; t += 3)
    indices.push((wall.indices[t] as number) + offset, (wall.indices[t + 2] as number) + offset, (wall.indices[t + 1] as number) + offset);
  return { positions, indices };
}

describe('fit_surface_to_mesh faceGroups', () => {
  const plates = withGroups(twoPlates(), { left: [[0, 128]], right: [[128, 256]], both: [[0, 256]] });

  it('fits the triangles of a stored group, and only those: each plate gets its own plane', () => {
    for (const [name, z, x0] of [
      ['left', 0, 0],
      ['right', 3, 20],
    ] as const) {
      const result = execute(plates.doc, 'fit_surface_to_mesh', { id: plates.id, faceGroups: { stored: [name] }, controlPoints: [5, 5] });
      expect(result.error, result.summary).toBeUndefined();
      const poles = polesOf(result.document, result.affected[0] as string);
      expect(poles.every((p) => Math.abs(p[2] - z) < 1e-6)).toBe(true);
      expect(Math.min(...poles.map((p) => p[0]))).toBeGreaterThan(x0 - 1);
      expect(Math.max(...poles.map((p) => p[0]))).toBeLessThan(x0 + 11);
      expect(dataOf(result)).toMatchObject({ regionTriangles: 128, faceGroups: { stored: 1, segments: 0, triangles: 128 } });
    }
    // without the groups the two plates are one region (a plane through both: not a plane of either)
    const whole = execute(plates.doc, 'fit_surface_to_mesh', { id: plates.id, controlPoints: [5, 5] });
    expect(dataOf(whole)['regionTriangles']).toBe(256);
    expect(dataOf(whole)['maxDeviation'] as number).toBeGreaterThan(0.3);
  });

  it('takes the union of several groups and the intersection with a sphere region', () => {
    const union = execute(plates.doc, 'fit_surface_to_mesh', {
      id: plates.id,
      faceGroups: { stored: ['left', 'right'] },
      controlPoints: [5, 5],
    });
    expect(dataOf(union)['regionTriangles']).toBe(256);
    const cut = execute(plates.doc, 'fit_surface_to_mesh', {
      id: plates.id,
      faceGroups: { stored: ['both'] },
      region: { center: [5, 5, 0], radius: 3 },
      degree: 1,
      controlPoints: [3, 3],
    });
    expect(cut.error, cut.summary).toBeUndefined();
    const inRegion = dataOf(cut)['regionTriangles'] as number;
    expect(inRegion).toBeGreaterThan(0);
    expect(inRegion).toBeLessThan(128);
    const none = execute(plates.doc, 'fit_surface_to_mesh', {
      id: plates.id,
      faceGroups: { stored: ['left'] },
      region: { center: [25, 5, 3], radius: 1 },
    });
    expect(codeOf(none)).toBe('MESH_FIT_REGION_EMPTY');
    expect(none.summary).toContain('named face groups');
  });

  it('takes segment_mesh regions by id: the wall of an inner corner fits the plane x = 10', () => {
    const { doc, ids } = docWithMeshes(corner());
    const id = ids[0] as string;
    const listed = execute(doc, 'segment_mesh', { id });
    expect(listed.error, listed.summary).toBeUndefined();
    const groups = (dataOf(listed)['groups'] as Array<{ id: string; faces: number }>).map((group) => group.id);
    expect(groups).toEqual(['seg-0', 'seg-1']);
    for (const [segment, plane] of [
      ['seg-0', 2],
      ['seg-1', 0],
    ] as const) {
      const result = execute(doc, 'fit_surface_to_mesh', { id, faceGroups: { segments: [segment] }, controlPoints: [5, 5] });
      expect(result.error, result.summary).toBeUndefined();
      const poles = polesOf(result.document, result.affected[0] as string);
      const spread = [0, 1, 2].map(
        (axis) => Math.max(...poles.map((p) => p[axis] as number)) - Math.min(...poles.map((p) => p[axis] as number)),
      );
      expect(spread[plane] as number, segment).toBeLessThan(1e-6);
      expect(dataOf(result)).toMatchObject({ faceGroups: { stored: 0, segments: 1 } });
    }
    // several segments: the union, here the whole L-shaped bend (a disk: the harmonic map takes it when asked)
    const both = execute(doc, 'fit_surface_to_mesh', {
      id,
      faceGroups: { segments: ['seg-0', 'seg-1'] },
      parameterization: 'harmonic',
      controlPoints: [5, 5],
    });
    expect(both.error, both.summary).toBeUndefined();
    expect(dataOf(both)).toMatchObject({ regionTriangles: 256, faceGroups: { segments: 2 }, parameterization: { method: 'harmonic' } });
    // the segmentation parameters of the listing call are repeated: a feature angle of 120 degrees merges the two planes into one region
    const merged = execute(doc, 'fit_surface_to_mesh', {
      id,
      faceGroups: { segments: ['seg-0'], featureAngleDeg: 120 },
      parameterization: 'harmonic',
      controlPoints: [5, 5],
    });
    expect(merged.error, merged.summary).toBeUndefined();
    expect(dataOf(merged)['regionTriangles']).toBe(256);
    expect(dataOf(merged)['parameterization']).toMatchObject({ method: 'harmonic' });
  });

  it('validates by name: unknown stored or segment ids list what exists, a stale group, an empty selector, groups of a mesh that stores none', () => {
    const cases: Array<[CadDocument, Record<string, unknown>, string, RegExp]> = [
      [
        plates.doc,
        { id: plates.id, faceGroups: { stored: ['wing'] } },
        'MESH_FIT_GROUP_NOT_FOUND',
        /stores no face group 'wing'; it stores left, right, both/,
      ],
      [
        plates.doc,
        { id: plates.id, faceGroups: { segments: ['seg-99'] } },
        'MESH_FIT_GROUP_NOT_FOUND',
        /no region 'seg-99'; it has seg-0, seg-1/,
      ],
      [plates.doc, { id: plates.id, faceGroups: { segments: ['left'] } }, 'MESH_FIT_GROUP_NOT_FOUND', /no region 'left'/],
      [plates.doc, { id: plates.id, faceGroups: {} }, 'MESH_PARAM_INVALID', /needs `stored` or `segments`/],
      [plates.doc, { id: plates.id, faceGroups: { stored: [] } }, 'CMD_INVALID_PARAMS', /./],
      [
        docWithMeshes(twoPlates()).doc,
        { id: docWithMeshes(twoPlates()).ids[0], faceGroups: { stored: ['left'] } },
        'MESH_FIT_GROUP_NOT_FOUND',
        /stores none/,
      ],
      [
        withGroups(twoPlates(), { stale: [[0, 9999]] }).doc,
        { id: withGroups(twoPlates(), {}).id, faceGroups: { stored: ['stale'] } },
        'MESH_FIT_GROUP_NOT_FOUND',
        /stale/,
      ],
    ];
    for (const [doc, params, code, message] of cases) {
      const result = execute(doc, 'fit_surface_to_mesh', params);
      expectNoOp(result, doc);
      expect(codeOf(result), JSON.stringify(params)).toBe(code);
      expect(result.summary).toMatch(message);
    }
  });

  it('is pure', () => {
    expectPure(plates.doc, () =>
      execute(plates.doc, 'fit_surface_to_mesh', { id: plates.id, faceGroups: { stored: ['left'] }, controlPoints: [5, 5] }),
    );
  });
});

describe('fit_subdivision_to_mesh faceGroups', () => {
  /** A ball of radius 10 (stored group "ball", triangles 0 to 5,119) and a small far ball (group "small"). */
  function ballAndSmall(): { doc: CadDocument; cageId: string; targetId: string } {
    const big = icosphere(10, 4);
    const small = icosphere(3, 2);
    const offset = big.positions.length / 3;
    const target: IndexedMesh = {
      positions: [...big.positions, ...small.positions.map((v, i) => (i % 3 === 0 ? v + 30 : v))],
      indices: [...big.indices, ...small.indices.map((i) => i + offset)],
    };
    const { doc, id } = withGroups(target, {
      ball: [[0, big.indices.length / 3]],
      small: [[big.indices.length / 3, target.indices.length / 3]],
    });
    const cage = quadSphere(10, 8);
    const added = execute(doc, 'add_subdivision_solid', {
      vertices: Array.from({ length: cage.positions.length / 3 }, (_, i) => [
        cage.positions[3 * i],
        cage.positions[3 * i + 1],
        cage.positions[3 * i + 2],
      ]),
      faces: Array.from({ length: cage.quads.length / 4 }, (_, f) => cage.quads.slice(4 * f, 4 * f + 4)),
      creases: [],
      levels: 2,
    });
    expect(added.error, added.summary).toBeUndefined();
    return { doc: added.document, cageId: added.affected[0] as string, targetId: id };
  }
  const setup = ballAndSmall();

  it('follows the group of the target: the cage fits the ball with the small ball beside it ignored', () => {
    const { doc, cageId, targetId } = setup;
    const result = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05, faceGroups: { stored: ['ball'] } });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf(result);
    expect(data['converged'], result.summary).toBe(true);
    expect(data['faceGroups']).toEqual({ stored: 1, segments: 0, triangles: 5120 });
    const entity = result.document.entities[cageId] as SubdivisionEntity;
    const limit = limitSurfaceMesh({ vertices: entity.vertices, faces: entity.faces, creases: entity.creases }, 3).mesh;
    const radii = Array.from({ length: limit.positions.length / 3 }, (_, i) =>
      Math.hypot(limit.positions[3 * i] as number, limit.positions[3 * i + 1] as number, limit.positions[3 * i + 2] as number),
    );
    expect(Math.max(...radii)).toBeLessThan(10.1);
    expect(Math.min(...radii)).toBeGreaterThan(9.8);
    // the group named small is far from the cage: refused by the cage-on-target rule, with the group's own size
    const far = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05, faceGroups: { stored: ['small'] } });
    expect(codeOf(far)).toBe('MESH_FIT_CAGE_FAR');
  });

  it('validates by name and is pure', () => {
    const { doc, cageId, targetId } = setup;
    const missing = execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05, faceGroups: { stored: ['wing'] } });
    expectNoOp(missing, doc);
    expect(codeOf(missing)).toBe('MESH_FIT_GROUP_NOT_FOUND');
    expect(missing.summary).toContain('it stores ball, small');
    expectPure(doc, () =>
      execute(doc, 'fit_subdivision_to_mesh', { cageId, targetId, maxDeviation: 0.05, faceGroups: { stored: ['ball'] } }),
    );
  });
});
