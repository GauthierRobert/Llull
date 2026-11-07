import { describe, it, expect, vi } from 'vitest';
import type { GeometryKernel, ShapeHandle } from '@core/geometry/kernel';
import { type ExtrusionEntity, type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp } from '../helpers/expectNoOp';
import { docWith, volumeOf as massVolume } from '../helpers/fixtureDocument';
import { ctxWith, manifoldSuite, meshOf, volumeOf } from '../helpers/featureSupport';

const plate = { id: 'plate', kind: 'rectangle', width: 100, height: 60 };
const hole = { id: 'hole', kind: 'circle', center: [50, 30], radius: 10 };

describe('extrude_profile of a region without a kernel', () => {
  it('a region without holes is an exact extrusion: the outer loop, curves kept, region kept', () => {
    const doc = execute(docWith(hole), 'hatch_region', { ids: ['hole'] }).document;
    const regionId = doc.order[1] as string;
    const result = execute(doc, 'extrude_profile', { id: regionId, depth: 7 });
    expect(result.affected).toHaveLength(1);
    const solid = result.document.entities[result.affected[0] as string] as ExtrusionEntity;
    expect(solid.kind).toBe('extrusion');
    expect(solid.depth).toBe(7);
    expect(solid.curves).toHaveLength(2);
    expect(result.document.entities[regionId]?.kind).toBe('region');
    expect(result.summary).toContain(`region "${regionId}"`);
    // pi r^2 h = 100 pi * 7, exact kernel-free mass properties integrate the 32-gon (0.64 % low)
    expect(massVolume(result.document, solid.id) / (700 * Math.PI)).toBeCloseTo(1, 1);
  });

  it('holes need a kernel: REGION_NEEDS_KERNEL, unchanged document', () => {
    const doc = execute(docWith(plate, hole), 'hatch_region', { ids: ['plate', 'hole'] }).document;
    const result = execute(doc, 'extrude_profile', { id: doc.order[2] as string, depth: 10 });
    expectNoOp(result, doc, 'REGION_NEEDS_KERNEL');
    expect(result.error?.code).toBe('REGION_NEEDS_KERNEL');
  });

  it('refuses depth <= 0 on a region', () => {
    const doc = execute(docWith(plate), 'hatch_region', { ids: ['plate'] }).document;
    expectNoOp(execute(doc, 'extrude_profile', { id: doc.order[1] as string, depth: 0 }), doc, 'depth must be > 0');
  });
});

describe('extrude_profile of a region with a kernel', () => {
  manifoldSuite();

  it('plate with a diameter-20 hole, 10 deep: (6000 - 100 pi) x 10 = 56858.4 (polygon hole within 0.5 %)', () => {
    const doc = execute(docWith(plate, hole), 'hatch_region', { ids: ['plate', 'hole'] }).document;
    const regionId = doc.order[2] as string;
    const result = execute(doc, 'extrude_profile', { id: regionId, depth: 10 });
    expect(result.affected, result.summary).toHaveLength(1);
    const id = result.affected[0] as string;
    expect(meshOf(result.document, id).kind).toBe('mesh');
    expect(volumeOf(result.document, id) / ((6000 - 100 * Math.PI) * 10)).toBeCloseTo(1, 2);
    expect(result.summary).toContain('1 hole loop(s) subtracted');
    expect(result.document.entities[regionId]?.kind).toBe('region');
  });

  it('an island inside a hole is united back: 100x100 - 60x60 + 20x20, 5 deep = 6800 x 5', () => {
    const rect = (id: string, size: number, at: number): Record<string, unknown> => ({
      id,
      kind: 'rectangle',
      width: size,
      height: size,
      position: [at, at, 0],
    });
    const doc = execute(docWith(rect('o', 100, 0), rect('h', 60, 20), rect('i', 20, 40)), 'hatch_region', {
      ids: ['o', 'h', 'i'],
    }).document;
    const result = execute(doc, 'extrude_profile', { id: doc.order[3] as string, depth: 5 });
    expect(result.affected).toHaveLength(1);
    expect(volumeOf(result.document, result.affected[0] as string)).toBeCloseTo(6800 * 5, 3);
  });

  it('honours position and axis overrides', () => {
    const doc = execute(docWith(plate, hole), 'hatch_region', { ids: ['plate', 'hole'] }).document;
    const result = execute(doc, 'extrude_profile', { id: doc.order[2] as string, depth: 2, position: [0, 0, 5] });
    const mesh = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    const zs = mesh.mesh.positions.filter((_, k) => k % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(5, 6);
    expect(Math.max(...zs)).toBeCloseTo(7, 6);
  });

  it('empty document stays empty without a region id', () => {
    const empty = createEmptyDocument();
    expectNoOp(execute(empty, 'extrude_profile', { id: 'nope', depth: 1 }), empty);
  });
});

/** A kernel that answers however the test says; never a real shape. */
const stubKernel = (evaluate: GeometryKernel['evaluate'], tessellate: GeometryKernel['tessellate'] = () => null): GeometryKernel => ({
  supports: () => true,
  evaluate,
  tessellate,
  topology: () => null,
  exportStep: () => null,
});

/** A region built by hand (no exact curves): a 10 x 10 outer loop with a 2 x 2 hole. */
const HAND_BUILT = docWith({
  id: 'r',
  kind: 'region',
  loops: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
    ],
  ],
});

describe('extrude_profile of a region: kernel failures and odd inputs', () => {
  it('a kernel that cannot build the prisms: REGION_KERNEL_BUILD_FAILED, unchanged document', () => {
    const result = execute(HAND_BUILT, 'extrude_profile', { id: 'r', depth: 3 }, ctxWith(stubKernel(() => null)));
    expectNoOp(result, HAND_BUILT, 'REGION_KERNEL_BUILD_FAILED');
    expect(result.error?.code).toBe('REGION_KERNEL_BUILD_FAILED');
    expect(result.summary).toContain('refused');
  });

  it('a kernel whose shape tessellates to nothing is the same refusal (empty)', () => {
    const empty = stubKernel(
      () => ({}) as ShapeHandle,
      () => ({ positions: [], indices: [] }),
    );
    const result = execute(HAND_BUILT, 'extrude_profile', { id: 'r', depth: 3 }, ctxWith(empty));
    expectNoOp(result, HAND_BUILT, 'REGION_KERNEL_BUILD_FAILED');
    expect(result.summary).toContain('empty');
  });

  it('a zero-length axis on a holed region is refused before the kernel is asked', () => {
    const evaluate = vi.fn(() => null);
    const result = execute(HAND_BUILT, 'extrude_profile', { id: 'r', depth: 3, axis: [0, 0, 0] }, ctxWith(stubKernel(evaluate)));
    expectNoOp(result, HAND_BUILT, 'axis must be 3 finite numbers');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a hand-built region without curves extrudes without a kernel (no exact copy stored)', () => {
    const plain = docWith({
      id: 'p',
      kind: 'region',
      loops: [
        [
          [0, 0],
          [10, 0],
          [10, 5],
          [0, 5],
        ],
      ],
    });
    const result = execute(plain, 'extrude_profile', { id: 'p', depth: 2 });
    const extrusion = result.document.entities[result.affected[0] as string] as ExtrusionEntity;
    expect(extrusion.curves).toBeUndefined();
    expect(extrusion.profile).toHaveLength(4);
    expect(massVolume(result.document, extrusion.id)).toBeCloseTo(100, 9);
  });

  it('a hand-built holed region without a kernel needs one (REGION_NEEDS_KERNEL)', () => {
    expectNoOp(execute(HAND_BUILT, 'extrude_profile', { id: 'r', depth: 3 }), HAND_BUILT, 'REGION_NEEDS_KERNEL');
  });
});

describe('extrude_profile of a hand-built holed region with a kernel', () => {
  manifoldSuite();

  it('polygon loops only: (10 x 10 - 2 x 2) x 3 = 288 exactly', () => {
    const result = execute(HAND_BUILT, 'extrude_profile', { id: 'r', depth: 3 });
    expect(result.affected, result.summary).toHaveLength(1);
    expect(volumeOf(result.document, result.affected[0] as string)).toBeCloseTo(288, 6);
  });
});
