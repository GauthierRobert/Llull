/** SC-F1: draft_faces, push_pull_face, split_face, replace_face (exact-kernel face operations) and split_body (any kernel with booleans). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type MeshSolidEntity } from '@core/model/types';
import type { FaceOpParams } from '@core/model/faceOps';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { getGeometryKernel, setGeometryKernel, type GeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import { kernelFromOps, type FaceQueryOps } from '@core/geometry/shapeKernel';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { TETRA } from '../helpers/fakeKernel';
import { expectPure } from '../helpers/expectNoOp';
import { manifoldSuite } from '../helpers/featureSupport';

const manifold = manifoldSuite();
beforeEach(() => setGeometryKernel(manifold()));
afterEach(() => setGeometryKernel(manifold()));

const FACES: ShapeTopology['faces'] = [
  { index: 0, name: 'b:z+', surface: 'plane', area: 100, normal: [0, 0, 1] },
  { index: 1, name: 'b:x+', surface: 'plane', area: 100, normal: [1, 0, 0] },
  { index: 2, name: 'b:side', surface: 'cylinder', area: 50 },
];
const DETAILS = [
  { index: 0, surface: 'plane', area: 100, centroid: [0, 0, 5], normal: [0, 0, 1], samples: [] },
  { index: 1, surface: 'plane', area: 100, centroid: [5, 0, 0], normal: [1, 0, 0], samples: [] },
  { index: 2, surface: 'cylinder', area: 50, centroid: [0, 5, 0], samples: [] },
];

/** An exact-looking kernel that records every faceOp node it is asked to build. */
function exactKernel(): { ops: FaceOpParams[] } {
  const ops: FaceOpParams[] = [];
  const kernel = kernelFromOps<{ readonly tag: string }>({
    solid: () => ({ tag: 'solid' }),
    boolean: () => null,
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape) => shape,
    scale: (shape) => shape,
    faceOp: (_source, params) => {
      ops.push(params);
      return { tag: 'faceOp' };
    },
    tessellate: () => ({ positions: [-5, -5, -5, 5, -5, -5, 0, 5, -5, 0, 0, 5], indices: TETRA.indices }),
    topology: () => ({ solids: 1, faces: FACES, edges: [], vertices: 8, volume: 1000 }),
    exportStep: () => null,
    release: () => undefined,
    faceQuery: {
      distance: (_shape: unknown, points: readonly (readonly number[])[]) =>
        points.map((point) => ({ distance: 0, signed: 0, face: (point[2] ?? 0) > 4 ? 0 : 1 })),
      faceDetails: () => DETAILS,
    } as unknown as FaceQueryOps<{ readonly tag: string }>,
  });
  setGeometryKernel(kernel as GeometryKernel);
  return { ops };
}

const boxDoc = (): CommandResult => execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });

describe('face operations on an exact kernel', () => {
  it('draft_faces drafts the picked faces about the lowest point along pull by default, and records their names', () => {
    const { ops } = exactKernel();
    const box = boxDoc();
    const drafted = execute(box.document, 'draft_faces', { id: box.affected[0], faceIndices: [1], angle: 3 });
    expect(ops.at(-1)).toMatchObject({ kind: 'draft', faces: [1], pull: [0, 0, 1], neutral: { origin: [-5, -5, -5], normal: [0, 0, 1] } });
    expect((ops.at(-1) as { angle: number }).angle).toBeCloseTo((3 * Math.PI) / 180, 12);
    expect(drafted.affected).toHaveLength(1);
    expect((drafted.document.entities[drafted.affected[0] ?? ''] as MeshSolidEntity).brep).toMatchObject({ op: 'faceOp', kind: 'draft' });
    expect(drafted.document.featureHistory.at(-1)?.params).toMatchObject({ faceNames: ['b:x+'] });
  });

  it('push_pull_face picks the face by point and moves it by the signed distance', () => {
    const { ops } = exactKernel();
    const box = boxDoc();
    const pulled = execute(box.document, 'push_pull_face', { id: box.affected[0], faceNear: [0, 0, 5], distance: -2 });
    expect(ops.at(-1)).toEqual({ kind: 'pushPull', faces: [0], distance: -2 });
    expect(pulled.summary).toMatch(/moved face 0 by -2/);
  });

  it('push_pull_face refuses a faceNear point that resolves to no face instead of sending face -1', () => {
    const { ops } = exactKernel();
    const box = boxDoc();
    const kernel = getGeometryKernel() as GeometryKernel;
    const query = kernel.faceQuery as unknown as { distance: (...args: unknown[]) => unknown };
    query.distance = (_shape: unknown, points: readonly (readonly number[])[]) => points.map(() => ({ distance: 0, signed: 0, face: -1 }));
    const pulled = execute(box.document, 'push_pull_face', { id: box.affected[0], faceNear: [0, 0, 5], distance: 1 });
    expect(pulled.document).toBe(box.document);
    expect(pulled.affected).toEqual([]);
    expect(pulled.summary).toContain('resolves to no single face');
    expect(ops).toEqual([]);
  });

  it('replace_face moves a planar face onto a parallel target plane, and refuses a tilted one', () => {
    const { ops } = exactKernel();
    const box = boxDoc();
    execute(box.document, 'replace_face', { id: box.affected[0], faceIndex: 0, target: { origin: [3, 3, 12], normal: [0, 0, -2] } });
    expect(ops.at(-1)).toEqual({ kind: 'pushPull', faces: [0], distance: 7 });
    const tilted = execute(box.document, 'replace_face', {
      id: box.affected[0],
      faceIndex: 0,
      target: { origin: [0, 0, 12], normal: [0, 1, 1] },
    });
    expect(tilted.document).toBe(box.document);
    expect(tilted.summary).toMatch(/not parallel/);
  });

  it('split_face sends the plane with a unit normal', () => {
    const { ops } = exactKernel();
    const box = boxDoc();
    execute(box.document, 'split_face', { id: box.affected[0], faceIndices: [0, 1], plane: { origin: [0, 0, 0], normal: [2, 0, 0] } });
    expect(ops.at(-1)).toEqual({ kind: 'splitFace', faces: [0, 1], plane: { origin: [0, 0, 0], normal: [1, 0, 0] } });
  });

  it('refuses a curved face for push-pull, a lost face name, and bad values', () => {
    exactKernel();
    const box = boxDoc();
    const id = box.affected[0];
    expect(execute(box.document, 'push_pull_face', { id, faceIndex: 2, distance: 1 }).summary).toMatch(/cylinder, not planar/);
    const lost = execute(box.document, 'push_pull_face', { id, faceName: 'b:gone', distance: 1 });
    expect(lost.error?.code).toBe('REF_LOST');
    expect(execute(box.document, 'draft_faces', { id, faceIndices: [1], angle: 95 }).summary).toMatch(/angle must be in/);
    expect(execute(box.document, 'push_pull_face', { id, faceIndex: 0, distance: 0 }).summary).toMatch(/non-zero/);
    expect(execute(box.document, 'draft_faces', { id, faceIndices: [9], angle: 2 }).summary).toMatch(/out of range/);
  });

  it('is pure', () => {
    exactKernel();
    const box = boxDoc();
    expectPure(box.document, () => execute(box.document, 'push_pull_face', { id: box.affected[0], faceIndex: 0, distance: 1 }));
  });
});

describe('face operations on a mesh kernel', () => {
  it('refuse with the reason (Manifold has no B-rep faces)', () => {
    const box = boxDoc();
    const refused = execute(box.document, 'push_pull_face', { id: box.affected[0], faceIndex: 0, distance: 1 });
    expect(refused.document).toBe(box.document);
    expect(refused.summary).toMatch(/face operations need the exact B-rep/);
  });
});

describe('faceOp recipe validation', () => {
  const source = { op: 'solid', entity: { id: 'b', kind: 'box' } };
  it.each([
    [{ kind: 'draft', faces: [0], angle: 0.1, pull: [0, 0, 1], neutral: { origin: [0, 0, 0], normal: [0, 0, 1] } }, null],
    [{ kind: 'draft', faces: [0], angle: 2, pull: [0, 0, 1], neutral: { origin: [0, 0, 0], normal: [0, 0, 1] } }, /angle/],
    [{ kind: 'pushPull', faces: [0, 1], distance: 1 }, /exactly one face/],
    [{ kind: 'splitFace', faces: [], plane: { origin: [0, 0, 0], normal: [0, 0, 1] } }, /non-empty/],
    [{ kind: 'twist', faces: [0] }, /unknown kind/],
  ])('%j', (params, problem) => {
    const verdict = validateShapeRecipe({ op: 'faceOp', source, ...params });
    if (problem === null) expect(verdict ?? '').not.toMatch(/faceOp/);
    else expect(verdict).toMatch(problem);
  });
});

describe('split_body (any kernel with booleans: Manifold here)', () => {
  it('splits a 10 mm cube at z = 2 into 700 + 300 mm³, normal side first', () => {
    const box = boxDoc();
    const split = execute(box.document, 'split_body', { id: box.affected[0], plane: { origin: [0, 0, 2], normal: [0, 0, 1] } });
    expect(split.affected).toHaveLength(2);
    const volumes = split.affected.map(
      (id) => (execute(split.document, 'mass_properties', { entityId: id }).data as { volume: number }).volume,
    );
    expect(volumes[0]).toBeCloseTo(300, 6);
    expect(volumes[1]).toBeCloseTo(700, 6);
    expect(split.document.entities[box.affected[0] ?? '']).toBeUndefined();
  });

  it('splits along a tilted plane and keeps the total volume', () => {
    const box = boxDoc();
    const split = execute(box.document, 'split_body', { id: box.affected[0], plane: { origin: [1, 0, 0], normal: [1, 1, 0.5] } });
    const total = split.affected
      .map((id) => (execute(split.document, 'mass_properties', { entityId: id }).data as { volume: number }).volume)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1000, 6);
  });

  it('refuses a plane that misses the solid and a zero normal', () => {
    const box = boxDoc();
    const id = box.affected[0];
    expect(execute(box.document, 'split_body', { id, plane: { origin: [0, 0, 50], normal: [0, 0, 1] } }).summary).toMatch(/does not cut/);
    expect(execute(box.document, 'split_body', { id, plane: { origin: [0, 0, 0], normal: [0, 0, 0] } }).summary).toMatch(/non-zero/);
  });
});
