import { describe, it, expect } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { kernelEntityBounds } from '@core/geometry/bounds';
import type { CadDocument, Entity, Vec3 } from '@core/model/types';
import { expectPure } from '../helpers/expectNoOp';
import { build } from '../helpers/addEntity';
import { fakeKernel, TETRA } from '../helpers/fakeKernel';

const TIGHT: { min: Vec3; max: Vec3 } = { min: [-1060, -1060, -1000], max: [1060, 1060, 1000] };

function withRing(): { doc: CadDocument; ring: Entity; box: Entity } {
  const { doc } = build(['add_box', { size: [2, 2, 2], position: [0, 0, 0] }]);
  const box = doc.entities[doc.order[0]!]!;
  const ring = {
    id: 'ring',
    kind: 'revolution',
    color: '#c8553d',
    layerId: box.layerId,
    position: [0, 0, 0],
    rotation: [0.5, 0, 0],
    profile: [
      [900, 0],
      [1060, 0],
      [1060, 100],
      [900, 100],
    ],
    axis: [0, 1, 0],
    angle: 4.71238898,
    segments: 32,
  } as unknown as Entity;
  return { doc: { ...doc, entities: { ...doc.entities, ring }, order: [...doc.order, 'ring'] }, ring, box };
}

describe('TR-ASC-15 exact bounds of kernel-backed entities', () => {
  it('kernelEntityBounds answers from kernel.shapeBounds of the placed shape', () => {
    const { ring } = withRing();
    expect(kernelEntityBounds(ring, fakeKernel({ shapeBounds: TIGHT }))).toEqual(TIGHT);
  });

  it('is null without a kernel, without the port, for a box or a mesh without B-rep, or when the kernel refuses or throws', () => {
    const { ring, box } = withRing();
    const tight = fakeKernel({ shapeBounds: TIGHT });
    expect(kernelEntityBounds(ring, null)).toBeNull();
    expect(kernelEntityBounds(ring, undefined)).toBeNull();
    expect(kernelEntityBounds(ring, fakeKernel())).toBeNull();
    expect(kernelEntityBounds(box, tight)).toBeNull();
    expect(kernelEntityBounds(ring, fakeKernel({ shapeBounds: null }))).toBeNull();
    const plain = { ...box, kind: 'mesh', mesh: { positions: [], indices: [] } } as unknown as Entity;
    expect(kernelEntityBounds(plain, tight)).toBeNull();
    expect(kernelEntityBounds(ring, fakeKernel({ shapeBounds: TIGHT, solid: null }))).toBeNull();
    const failing = fakeKernel({ shapeBounds: TIGHT });
    failing.evaluate = () => {
      throw new Error('boom');
    };
    expect(kernelEntityBounds(ring, failing)).toBeNull();
  });

  it('a kernel result with a B-rep takes the kernel box', () => {
    const kernel = fakeKernel({ shapeBounds: TIGHT, boolean: TETRA });
    const ctx = { ...defaultContext(), kernel };
    const first = execute(build(['add_box', { size: [1, 1, 1] }]).doc, 'add_box', { size: [1, 1, 1] }, ctx);
    const [a, b] = first.document.order;
    const union = execute(first.document, 'boolean', { op: 'union', a, b }, ctx);
    const r = execute(union.document, 'measure_bounding_box', { entityId: union.affected[0]! }, ctx);
    expect(r.data).toMatchObject({ ...TIGHT, bounds: 'exact' });
  });

  it('measure_bounding_box: exact with a kernel, conservative without; a combined box is conservative when any entity is', () => {
    const { doc } = withRing();
    const ctx = { ...defaultContext(), kernel: fakeKernel({ shapeBounds: TIGHT }) };
    const exact = execute(doc, 'measure_bounding_box', { entityId: 'ring' }, ctx);
    expect(exact.data).toMatchObject({ min: TIGHT.min, max: TIGHT.max, size: [2120, 2120, 2000], bounds: 'exact' });
    expect(exact.summary).toContain('(exact)');
    expect(execute(doc, 'measure_bounding_box', {}, ctx).data).toMatchObject({ bounds: 'conservative' });
    const none = execute(doc, 'measure_bounding_box', { entityId: 'ring' }, { ...defaultContext(), kernel: null });
    expect(none.data).toMatchObject({ bounds: 'conservative' });
    expect((none.data as { min: number[] }).min).not.toEqual(TIGHT.min);
    expectPure(doc, () => execute(doc, 'measure_bounding_box', { entityId: 'ring' }, ctx));
  });
});
