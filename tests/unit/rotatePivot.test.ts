import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { entityBoundsInDoc, boundsCenter } from '@core/geometry/bounds';
import { matFromEulerXYZ, mulMat3 } from '@lib/axisRotation';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { add } from '../helpers/addEntity';

const close = (actual: readonly number[] | undefined, expected: number[]): void =>
  expected.forEach((v, i) => expect(actual?.[i]).toBeCloseTo(v, 9));

/** A 10×2×2 box whose origin is at [10, 0, 0]. */
const offAxisBox = (): ReturnType<typeof add> => add(createEmptyDocument(), 'add_box', { size: [10, 2, 2], position: [10, 0, 0] });

describe('rotate_entity pivot (LIM-1)', () => {
  it('without a pivot keeps the legacy Euler-add, position unchanged', () => {
    const { doc, id } = offAxisBox();
    const r = execute(doc, 'rotate_entity', { id, delta: [0, 0, Math.PI / 2] });
    close(r.document.entities[id]?.position, [10, 0, 0]);
    close(r.document.entities[id]?.rotation, [0, 0, Math.PI / 2]);
  });

  it('a world pivot turns the entity rigidly about that point', () => {
    const { doc, id } = offAxisBox();
    const r = execute(doc, 'rotate_entity', { id, delta: [0, 0, Math.PI / 2], pivot: [0, 0, 0] });
    expect(r.affected).toEqual([id]);
    close(r.document.entities[id]?.position, [0, 10, 0]);
    close(r.document.entities[id]?.rotation, [0, 0, Math.PI / 2]);
    expect(r.summary).toContain('about [0, 0, 0]');
  });

  it('"center" keeps the bounding-box center fixed', () => {
    const { doc, id } = offAxisBox();
    const before = boundsCenter(entityBoundsInDoc(doc, doc.entities[id]!));
    const r = execute(doc, 'rotate_entity', { id, delta: [Math.PI, 0, 0], pivot: 'center' });
    const after = boundsCenter(entityBoundsInDoc(r.document, r.document.entities[id]!));
    close(after, [...before]);
  });

  it('composes with an existing rotation in the world frame', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], rotation: [Math.PI / 2, 0, 0] });
    const r = execute(doc, 'rotate_entity', { id, delta: [0, 0, Math.PI / 2], pivot: [0, 0, 0] });
    close(r.document.entities[id]?.position, [0, 0, 0]);
    const expected = mulMat3(matFromEulerXYZ([0, 0, Math.PI / 2]), matFromEulerXYZ([Math.PI / 2, 0, 0]));
    close(matFromEulerXYZ(r.document.entities[id]!.rotation).flat(), expected.flat());
  });

  it('a bad pivot is a no-op', () => {
    const { doc, id } = offAxisBox();
    expectNoOp(execute(doc, 'rotate_entity', { id, delta: [0, 0, 1], pivot: [0, 0] }), doc, 'pivot must be 3 finite numbers');
  });

  it('is pure', () => {
    const { doc, id } = offAxisBox();
    expectPure(doc, () => execute(doc, 'rotate_entity', { id, delta: [0, 0, 1], pivot: 'center' }));
  });
});
