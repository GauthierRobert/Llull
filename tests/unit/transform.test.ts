import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { docWith } from '../helpers/fixtureDocument';
import { add } from '../helpers/addEntity';
import { xy } from '../helpers/xy';

type Pos = [number, number, number];
const SIZE = [2, 4, 6];
const boxAt = (position: Pos = [0, 0, 0]): { doc: CadDocument; id: string } =>
  add(createEmptyDocument(), 'add_box', { size: SIZE, position });
/** Box at `position`, then `cmd` on it. */
function onBox(cmd: string, extra: object, position?: Pos): { doc: CadDocument; id: string; r: ReturnType<typeof execute> } {
  const { doc, id } = boxAt(position);
  return { doc, id, r: execute(doc, cmd, { id, ...extra }) };
}
const close = (actual: readonly number[], expected: number[]): void => expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v));

describe('transform commands', () => {
  it.each<[string, object, Pos?]>([
    ['rotate_entity', { delta: [1, 2, 3] }],
    ['scale_entity', { factor: 3 }],
    ['mirror_entity', { axis: 'y' }, [1, 2, 3]],
    ['array_linear', { count: 3, offset: [2, 0, 0] }],
    ['array_polar', { count: 4, center: [0, 0, 0] }, [2, 0, 0]],
  ])('%s is pure', (cmd, extra, position) => {
    const { doc, id } = boxAt(position);
    expectPure(doc, () => execute(doc, cmd, { id, ...extra }));
  });

  it.each<[string, object, string?]>([
    ['rotate_entity', { id: 'ghost', delta: [1, 0, 0] }, 'ghost'],
    ['scale_entity', { id: 'nope', factor: 2 }],
    ['mirror_entity', { id: 'missing', axis: 'x' }, 'missing'],
    ['array_linear', { id: 'ghost', count: 3, offset: [1, 0, 0] }, 'ghost'],
    ['array_polar', { id: 'nope', count: 4, center: [0, 0, 0] }, 'nope'],
  ])('%s %j on a missing id is a no-op', (cmd, p, summary) => {
    const doc = createEmptyDocument();
    expectNoOp(execute(doc, cmd, p), doc, summary);
  });

  it.each<[string, object, (string | RegExp)?]>([
    ['scale_entity', { factor: 0 }],
    ['scale_entity', { factor: -1 }],
    ['mirror_entity', { axis: 'w' }, "'w'"],
    ['array_linear', { count: 1, offset: [1, 0, 0] }],
    ['array_linear', { count: 3, offset: [Infinity, 0, 0] }],
    ['array_polar', { count: 1, center: [0, 0, 0] }],
    ['rotate_entity', { delta: [0.5] }, /finite/],
    ['array_linear', { count: 3, offset: [1, 2] }, /finite/],
    ['array_polar', { count: 3, center: [0] }, /finite/],
  ])('%s %j is rejected without NaN geometry', (cmd, extra, summary) => {
    const { doc, r } = onBox(cmd, extra, [2, 0, 0]);
    expectNoOp(r, doc);
    if (summary instanceof RegExp) expect(r.summary).toMatch(summary);
    else if (summary) expect(r.summary).toContain(summary);
  });

  it('rotate_entity accumulates rotation and keeps position and size', () => {
    const { id, r } = onBox('rotate_entity', { delta: [0.1, 0.2, 0.3] }, [3, 5, 7]);
    expect(r.affected).toEqual([id]);
    close(r.document.entities[id]!.rotation, [0.1, 0.2, 0.3]);
    expect(r.document.entities[id]).toMatchObject({ position: [3, 5, 7], size: SIZE });
    const again = execute(execute(boxAt().doc, 'rotate_entity', { id, delta: [1, 0, 0] }).document, 'rotate_entity', {
      id,
      delta: [0, 0, 0.5],
    });
    close(again.document.entities[id]!.rotation, [1, 0, 0.5]);
  });

  it.each<[string, Record<string, unknown>, number, Record<string, unknown>]>([
    ['box', { kind: 'box', size: [2, 4, 6] }, 2, { size: [4, 8, 12] }],
    ['cylinder', { kind: 'cylinder', radius: 3, height: 10 }, 0.5, { radius: 1.5, height: 5 }],
    ['sphere', { kind: 'sphere', radius: 6 }, 3, { radius: 18 }],
  ])('scale_entity scales a %s', (_, shape, factor, expected) => {
    const doc = docWith({ id: 'e', ...shape });
    const r = execute(doc, 'scale_entity', { id: 'e', factor });
    expect(r.affected).toEqual(['e']);
    expect(r.document.entities['e']).toMatchObject({ kind: shape['kind'], ...expected });
  });

  it('scale_entity scales an extrusion profile and depth', () => {
    const { doc, id } = add(createEmptyDocument(), 'extrude_profile', { profile: xy(0, 0, 1, 0, 1, 1, 0, 1), depth: 5 });
    expect(execute(doc, 'scale_entity', { id, factor: 2 }).document.entities[id]).toMatchObject({
      kind: 'extrusion',
      depth: 10,
      profile: xy(0, 0, 2, 0, 2, 2, 0, 2),
    });
  });

  it.each<[string, Pos, Pos]>([
    ['x', [4, 5, 6], [-4, 5, 6]],
    ['y', [1, 2, 3], [1, -2, 3]],
    ['z', [1, 2, 3], [1, 2, -3]],
  ])('mirror_entity across %s negates that coordinate only', (axis, at, mirrored) => {
    const { doc, id, r } = onBox('mirror_entity', { axis }, at);
    expect(r.affected).toEqual([id]);
    expect(r.document.entities[id]).toMatchObject({ position: mirrored, rotation: doc.entities[id]!.rotation, size: SIZE });
  });

  it('array_linear adds count-1 offset copies (same geometry, rotation, color, layer) after the original', () => {
    const { doc, id, r } = onBox('array_linear', { count: 4, offset: [2, 0, 0] }, [1, 2, 3]);
    expect(r.affected).toHaveLength(3);
    const original = doc.entities[id]!;
    expect(r.document.entities[id]!.position).toEqual([1, 2, 3]);
    r.affected.forEach((c, k) => {
      expect(r.document.entities[c]).toMatchObject({
        kind: 'box',
        size: SIZE,
        rotation: original.rotation,
        color: original.color,
        layerId: original.layerId,
      });
      expect(r.document.entities[c]!.position).toEqual([1 + 2 * (k + 1), 2, 3]);
    });
    expect(r.document.order).toEqual([id, ...r.affected]);
  });

  it('array_polar rotates copies about the centre (full circle or partial sweep) after the original', () => {
    const { id, r } = onBox('array_polar', { count: 4, center: [0, 0, 0] }, [2, 0, 0]);
    expect(r.affected).toHaveLength(3);
    expect(r.document.entities[id]!.position).toEqual([2, 0, 0]);
    expect(r.document.order).toEqual([id, ...r.affected]);
    [
      [0, 2],
      [-2, 0],
      [0, -2],
    ].forEach((p, k) => close(r.document.entities[r.affected[k]!]!.position, p));
    expect(r.document.entities[r.affected[0]!]!.rotation[2]).toBeCloseTo(Math.PI / 2);
    const half = onBox('array_polar', { count: 3, center: [0, 0, 0], angle: Math.PI }, [1, 0, 0]).r;
    expect(half.affected).toHaveLength(2);
    close(half.document.entities[half.affected[0]!]!.position, [Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)]);
  });
});
