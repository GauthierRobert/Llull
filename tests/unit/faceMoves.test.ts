/** DIR M6 command layer: move_faces / delete_faces (recipe nodes, refusals with stable codes, volume report) on a scripted exact kernel. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type MeshSolidEntity } from '@core/model/types';
import type { FaceOpParams } from '@core/model/faceOps';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { getGeometryKernel, setGeometryKernel, type GeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import { kernelFromOps, type FaceQueryOps } from '@core/geometry/shapeKernel';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { TETRA } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { manifoldSuite } from '../helpers/featureSupport';

const manifold = manifoldSuite();
beforeEach(() => setGeometryKernel(manifold()));
afterEach(() => setGeometryKernel(manifold()));

const FACES: ShapeTopology['faces'] = [
  { index: 0, name: 'p:z+', surface: 'plane', area: 100, normal: [0, 0, 1] },
  { index: 1, name: 'p:bore', surface: 'cylinder', area: 50 },
  { index: 2, name: 'p:ball', surface: 'sphere', area: 30 },
];
const DETAILS = [
  { index: 0, surface: 'plane', area: 100, centroid: [0, 0, 5], normal: [0, 0, 1], samples: [] },
  { index: 1, surface: 'cylinder', area: 50, centroid: [3, 0, 0], radius: 3, samples: [] },
  { index: 2, surface: 'sphere', area: 30, centroid: [0, 0, 9], radius: 2, samples: [] },
];

interface Scripted {
  readonly ops: FaceOpParams[];
}

/** An exact-looking kernel that records every faceOp node and answers volume 1000 for the source, 1100 for a faceOp result. */
function exactKernel(
  options: { refuse?: boolean; volumes?: boolean; details?: unknown[]; unbuildable?: boolean; faceQuery?: boolean } = {},
): Scripted {
  const ops: FaceOpParams[] = [];
  const kernel = kernelFromOps<{ readonly tag: string }>({
    solid: () => (options.unbuildable === true ? null : { tag: 'solid' }),
    boolean: () => null,
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape) => shape,
    scale: (shape) => shape,
    faceOp: (_source, params) => {
      ops.push(params);
      return options.refuse === true ? null : { tag: 'faceOp' };
    },
    tessellate: () => ({ positions: [-5, -5, -5, 5, -5, -5, 0, 5, -5, 0, 0, 5], indices: TETRA.indices }),
    topology: () => ({ solids: 1, faces: FACES, edges: [], vertices: 8, volume: 1000 }),
    exportStep: () => null,
    release: () => undefined,
    ...(options.volumes === false
      ? {}
      : {
          massProperties: (shape: { readonly tag: string }) =>
            ({ volume: shape.tag === 'faceOp' ? 1100.12345723 : 1000 }) as unknown as ReturnType<
              NonNullable<GeometryKernel['massProperties']>
            >,
        }),
    faceQuery: (options.faceQuery === false
      ? undefined
      : {
          distance: (_shape: unknown, points: readonly (readonly number[])[]) =>
            points.map((point) => ({ distance: 0, signed: 0, face: (point[2] ?? 0) > 4 ? 0 : 1 })),
          faceDetails: () => options.details ?? DETAILS,
        }) as unknown as FaceQueryOps<{ readonly tag: string }>,
  });
  setGeometryKernel(kernel as GeometryKernel);
  return { ops };
}

const boxDoc = (): CommandResult => execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
const code = (result: CommandResult): string | undefined => result.error?.code;

describe('move_faces', () => {
  it('sends an offset node, records the face names and reports the exact volumes', () => {
    const { ops } = exactKernel();
    const box = boxDoc();
    const moved = execute(box.document, 'move_faces', { id: box.affected[0], faceIndices: [1], mode: 'offset', distance: 1.5 });
    expect(ops.at(-1)).toEqual({ kind: 'moveFaces', faces: [1], move: { type: 'offset', distance: 1.5 } });
    expect(moved.affected).toHaveLength(1);
    expect((moved.document.entities[moved.affected[0] ?? ''] as MeshSolidEntity).brep).toMatchObject({ op: 'faceOp', kind: 'moveFaces' });
    expect(moved.document.featureHistory.at(-1)?.params).toMatchObject({ faceNames: ['p:bore'] });
    expect(moved.data).toMatchObject({ volumeBefore: 1000, volumeAfter: 1100.123457, volumeUnit: 'mm^3', faces: [1] });
    expect(moved.summary).toMatch(/Volume 1000 -> 1100.123457 mm\^3 \(exact\)/);
  });

  it('sends translate and rotate nodes (axis unit-normalised, angle in radians) picking faces by point', () => {
    const { ops } = exactKernel();
    const box = boxDoc();
    const id = box.affected[0];
    execute(box.document, 'move_faces', { id, facesNear: [[0, 0, 5]], mode: 'translate', vector: [1, 2, 3] });
    expect(ops.at(-1)).toEqual({ kind: 'moveFaces', faces: [0], move: { type: 'translate', vector: [1, 2, 3] } });
    execute(box.document, 'move_faces', {
      id,
      faceIndices: [0],
      mode: 'rotate',
      axis: { origin: [1, 0, 0], direction: [0, 4, 0] },
      angleDeg: 60,
    });
    const rotate = ops.at(-1) as Extract<FaceOpParams, { kind: 'moveFaces' }>;
    expect(rotate.move).toMatchObject({ type: 'rotate', axis: { origin: [1, 0, 0], direction: [0, 1, 0] } });
    expect((rotate.move as { angle: number }).angle).toBeCloseTo(Math.PI / 3, 12);
  });

  it('preview true builds the same node but skips the volume report and the exact-topology note', () => {
    exactKernel();
    const box = boxDoc();
    const id = box.affected[0];
    const full = execute(box.document, 'move_faces', { id, faceIndices: [1], mode: 'offset', distance: 1.5 });
    const dry = execute(box.document, 'move_faces', { id, faceIndices: [1], mode: 'offset', distance: 1.5, preview: true });
    expect(full.summary).toMatch(/Volume 1000/);
    expect(full.summary).toContain('Exact B-rep kept');
    expect(dry.affected).toHaveLength(1);
    expect(dry.data).toBeUndefined();
    expect(dry.summary).not.toMatch(/Volume/);
    expect(dry.summary).not.toContain('Exact B-rep kept');
    const gone = execute(box.document, 'delete_faces', { id, faceIndices: [1], preview: true });
    expect(gone.summary).not.toMatch(/Volume/);
  });

  it('leaves out the volume report when the kernel has no mass properties', () => {
    exactKernel({ volumes: false });
    const box = boxDoc();
    const moved = execute(box.document, 'move_faces', { id: box.affected[0], faceIndices: [0], mode: 'offset', distance: 1 });
    expect(moved.affected).toHaveLength(1);
    expect(moved.data).toBeUndefined();
  });

  it.each([
    ['translate without a vector', { mode: 'translate' }, 'params.vector'],
    ['translate with a zero vector', { mode: 'translate', vector: [0, 0, 0] }, 'params.vector'],
    ['rotate without an axis', { mode: 'rotate', angleDeg: 5 }, 'params.axis'],
    ['rotate with a zero axis', { mode: 'rotate', axis: { origin: [0, 0, 0], direction: [0, 0, 0] }, angleDeg: 5 }, 'params.axis'],
    ['rotate without an angle', { mode: 'rotate', axis: { origin: [0, 0, 0], direction: [0, 0, 1] } }, 'params.angleDeg'],
    ['rotate by 180', { mode: 'rotate', axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, angleDeg: 180 }, 'params.angleDeg'],
    ['offset without a distance', { mode: 'offset' }, 'params.distance'],
    ['offset by zero', { mode: 'offset', distance: 0 }, 'params.distance'],
  ])('refuses %s with DIR_FACE_MOVE_PARAMS', (_name, params, path) => {
    exactKernel();
    const box = boxDoc();
    const refused = execute(box.document, 'move_faces', { id: box.affected[0], faceIndices: [0], ...params });
    expect(code(refused)).toBe('DIR_FACE_MOVE_PARAMS');
    expect(refused.error?.paths).toEqual([path]);
    expectNoOp(refused, box.document);
  });

  it('refuses a rotation of one planar face by 85 degrees or more, but not of a round feature', () => {
    const { ops } = exactKernel();
    const box = boxDoc();
    const id = box.affected[0];
    const axis = { origin: [0, 0, 0], direction: [0, 0, 1] };
    const refused = execute(box.document, 'move_faces', { id, faceIndices: [0], mode: 'rotate', axis, angleDeg: 90 });
    expect(code(refused)).toBe('DIR_FACE_MOVE_PARAMS');
    expect(refused.summary).toMatch(/less than 85 degrees/);
    expect(refused.error?.remediation).toMatch(/85 degrees/);
    expectNoOp(refused, box.document);
    expect(execute(box.document, 'move_faces', { id, faceIndices: [0], mode: 'rotate', axis, angleDeg: 84 }).affected).toHaveLength(1);
    expect(execute(box.document, 'move_faces', { id, faceIndices: [1], mode: 'rotate', axis, angleDeg: 90 }).affected).toHaveLength(1);
    expect(ops.length).toBe(2);
  });

  it('refuses a round face that would vanish (DIR_FACE_MOVE_TOPOLOGY) and accepts one that just shrinks', () => {
    exactKernel();
    const box = boxDoc();
    const id = box.affected[0];
    const vanish = execute(box.document, 'move_faces', { id, faceIndices: [1], mode: 'offset', distance: -3 });
    expect(code(vanish)).toBe('DIR_FACE_MOVE_TOPOLOGY');
    expect(vanish.summary).toMatch(/radius 3/);
    expectNoOp(vanish, box.document);
    expect(code(execute(box.document, 'move_faces', { id, faceIndices: [2], mode: 'offset', distance: -2 }))).toBe(
      'DIR_FACE_MOVE_TOPOLOGY',
    );
    expect(execute(box.document, 'move_faces', { id, faceIndices: [1], mode: 'offset', distance: -2.9 }).affected).toHaveLength(1);
    expect(execute(box.document, 'move_faces', { id, faceIndices: [0], mode: 'offset', distance: -50 }).affected).toHaveLength(1);
  });

  it('answers DIR_FACE_MOVE_FAILED when the kernel cannot rebuild a solid', () => {
    exactKernel({ refuse: true });
    const box = boxDoc();
    const failed = execute(box.document, 'move_faces', { id: box.affected[0], faceIndices: [0], mode: 'translate', vector: [0, 0, 1] });
    expect(code(failed)).toBe('DIR_FACE_MOVE_FAILED');
    expect(failed.error?.ids).toEqual([box.affected[0]]);
    expect(failed.summary).toContain('(refused)');
    expectNoOp(failed, box.document);
  });

  it('names the reason the kernel gives for the refusal (DES-4c: the OCC words over the kernel port)', () => {
    exactKernel({ refuse: true });
    const kernel = getGeometryKernel() as GeometryKernel;
    setGeometryKernel({ ...kernel, lastRefusal: () => 'OCC_FAILURE: BRepOffset_MakeOffset: offset not done' });
    const box = boxDoc();
    const failed = execute(box.document, 'move_faces', { id: box.affected[0], faceIndices: [0], mode: 'offset', distance: 1 });
    expect(code(failed)).toBe('DIR_FACE_MOVE_FAILED');
    expect(failed.summary).toContain('(refused: OCC_FAILURE: BRepOffset_MakeOffset: offset not done)');
    expectNoOp(failed, box.document);
  });

  it('refuses a lost face name, a bad pick, a missing id and a mesh kernel', () => {
    exactKernel();
    const box = boxDoc();
    const id = box.affected[0];
    expect(code(execute(box.document, 'move_faces', { id, faceNames: ['p:gone'], mode: 'offset', distance: 1 }))).toBe('REF_LOST');
    expectNoOp(execute(box.document, 'move_faces', { id, faceIndices: [9], mode: 'offset', distance: 1 }), box.document, 'out of range');
    expectNoOp(execute(box.document, 'move_faces', { id: 'nope', faceIndices: [0], mode: 'offset', distance: 1 }), box.document);
    setGeometryKernel(manifold());
    expectNoOp(execute(box.document, 'move_faces', { id, faceIndices: [0], mode: 'offset', distance: 1 }), box.document, 'exact B-rep');
  });

  it('is pure', () => {
    exactKernel();
    const box = boxDoc();
    expectPure(box.document, () =>
      execute(box.document, 'move_faces', { id: box.affected[0], faceIndices: [0], mode: 'offset', distance: 1 }),
    );
  });
});

describe('the shared face-operation runner', () => {
  it('words a kernel refusal of a command without a coded failure, and a face without exact geometry', () => {
    exactKernel({ refuse: true });
    const box = boxDoc();
    const drafted = execute(box.document, 'draft_faces', { id: box.affected[0], faceIndices: [0], angle: 3 });
    expect(drafted.error).toBeUndefined();
    expectNoOp(drafted, box.document, 'could not');
    exactKernel({ details: [] });
    const plain = execute(box.document, 'push_pull_face', { id: box.affected[0], faceIndex: 2, distance: 1 });
    expect(plain.summary).toMatch(/no exact geometry/);
    exactKernel({ faceQuery: false });
    expect(execute(box.document, 'push_pull_face', { id: box.affected[0], faceIndex: 0, distance: 1 }).summary).toMatch(
      /no exact geometry/,
    );
    exactKernel({ unbuildable: true });
    expectNoOp(
      execute(box.document, 'push_pull_face', { id: box.affected[0], faceIndex: 0, distance: 1 }),
      box.document,
      'could not build',
    );
    exactKernel();
    expect(execute(box.document, 'push_pull_face', { id: box.affected[0], faceIndex: 1, distance: 1 }).summary).toMatch(/not planar/);
    const named = execute(box.document, 'push_pull_face', { id: box.affected[0], faceName: 'p:z+', distance: 1 });
    expect(named.affected).toHaveLength(1);
  });
});

describe('delete_faces', () => {
  it('sends a deleteFaces node and reports the volumes', () => {
    const { ops } = exactKernel();
    const box = boxDoc();
    const deleted = execute(box.document, 'delete_faces', { id: box.affected[0], facesNear: [[0, 0, 5]] });
    expect(ops.at(-1)).toEqual({ kind: 'deleteFaces', faces: [0] });
    expect(deleted.data).toMatchObject({ volumeBefore: 1000, faces: [0] });
    expect(deleted.document.featureHistory.at(-1)?.params).toMatchObject({ faceNames: ['p:z+'] });
  });

  it('answers DIR_DEFEATURE_FAILED when the kernel cannot heal the gap, and is pure', () => {
    exactKernel({ refuse: true });
    const box = boxDoc();
    const failed = execute(box.document, 'delete_faces', { id: box.affected[0], faceIndices: [0, 1] });
    expect(code(failed)).toBe('DIR_DEFEATURE_FAILED');
    expectNoOp(failed, box.document);
    exactKernel();
    expectPure(box.document, () => execute(box.document, 'delete_faces', { id: box.affected[0], faceIndices: [0] }));
  });
});

describe('moveFaces / deleteFaces recipe validation', () => {
  const source = { op: 'solid', entity: { id: 'b', kind: 'box' } };
  it.each([
    [{ kind: 'moveFaces', faces: [0], move: { type: 'offset', distance: 1 } }, null],
    [{ kind: 'moveFaces', faces: [0], move: { type: 'translate', vector: [0, 0, 1] } }, null],
    [{ kind: 'moveFaces', faces: [0], move: { type: 'rotate', axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, angle: 0.2 } }, null],
    [{ kind: 'moveFaces', faces: [0], move: { type: 'offset', distance: 0 } }, /offset: distance/],
    [{ kind: 'moveFaces', faces: [0], move: { type: 'translate', vector: [0, 0, 0] } }, /translate: vector/],
    [{ kind: 'moveFaces', faces: [0], move: { type: 'rotate', axis: { origin: [0, 0, 0], direction: [0, 0, 0] }, angle: 0.2 } }, /axis/],
    [{ kind: 'moveFaces', faces: [0], move: { type: 'rotate', axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, angle: 4 } }, /below 180/],
    [{ kind: 'moveFaces', faces: [0], move: { type: 'spin' } }, /unknown move type/],
    [{ kind: 'moveFaces', faces: [0] }, /move must be/],
    [{ kind: 'pushPull', faces: [0], distance: 0 }, /distance/],
    [{ kind: 'splitFace', faces: [0], plane: { origin: [0, 0, 0] } }, /plane/],
    [{ kind: 'deleteFaces', faces: [0, 1] }, null],
    [{ kind: 'deleteFaces', faces: [] }, /non-empty/],
  ])('%j', (params, problem) => {
    const verdict = validateShapeRecipe({ op: 'faceOp', source, ...params });
    if (problem === null) expect(verdict ?? '').not.toMatch(/faceOp/);
    else expect(verdict).toMatch(problem);
  });
});

describe('mass_properties surfaceModel of a subdivision solid', () => {
  const cube = execute(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 3, id: 'c' });
  const volumeOf = (params: object): { volume: number; surfaceModel?: string } =>
    execute(cube.document, 'mass_properties', { entityId: 'c', ...params }).data as { volume: number; surfaceModel?: string };

  it('measures the level mesh without an exact kernel, whatever is asked', () => {
    expect(volumeOf({})).toMatchObject({ surfaceModel: 'level_mesh' });
    expect(volumeOf({}).volume).toBeCloseTo(2.66462478968, 9);
    expect(volumeOf({ surfaceModel: 'limit_patches' })).toMatchObject({ surfaceModel: 'level_mesh' });
  });

  it('measures the limit patches only on request, with volume, centroid, inertia and method from that one solid', () => {
    const exact = {
      volume: 2.62,
      area: 24,
      centroid: [0.1, 0.2, 0.3],
      inertiaAtCentroid: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    };
    const kernel = {
      name: 'scripted',
      supports: () => true,
      evaluate: () => ({}) as never,
      tessellate: () => null,
      topology: () => ({ solids: 1, faces: [], edges: [], vertices: 0, volume: 2.62 }),
      exportStep: () => null,
      massProperties: () => exact as never,
      faceQuery: {} as never,
    } as unknown as GeometryKernel;
    setGeometryKernel(kernel);
    const level = execute(cube.document, 'mass_properties', { entityId: 'c' }).data as {
      surfaceModel: string;
      method: string;
      volume: number;
    };
    expect(level).toMatchObject({ surfaceModel: 'level_mesh', method: 'mesh' });
    expect(level.volume).toBeCloseTo(2.66462478968, 9);
    const patches = execute(cube.document, 'mass_properties', { entityId: 'c', surfaceModel: 'limit_patches' }).data as {
      surfaceModel: string;
      method: string;
      volume: number;
      centroid: number[];
    };
    expect(patches).toMatchObject({ surfaceModel: 'limit_patches', method: 'exact', volume: 2.62 });
    expect(patches.centroid.map((x) => Math.round(x * 1000) / 1000)).toEqual([0.1, 0.2, 0.3]);
    const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    expect(
      (execute(box.document, 'mass_properties', { entityId: box.affected[0] }).data as { surfaceModel?: string }).surfaceModel,
    ).toBeUndefined();
  });
});
