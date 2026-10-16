import { describe, it, expect } from 'vitest';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { groupedBoxes } from '../helpers/groupedBoxes';
import { computeSceneSnapshot } from '@core/commands/inspect/scene';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { entityBounds, instanceBoundsFromDoc } from '@core/geometry/bounds';
import { expectNoOp } from '../helpers/expectNoOp';
import { build } from '../helpers/addEntity';
import { xy } from '../helpers/xy';

type Snap = ReturnType<typeof computeSceneSnapshot>;
const BASE = { position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'layer-default', color: '#fff' };
const raw = (e: Record<string, unknown>): Entity => ({ ...BASE, id: 'e', ...e }) as unknown as Entity;
const only = (name: string, p: object): Entity => {
  const { doc, ids } = build([name, p]);
  return doc.entities[ids[0]!]!;
};
const close = (actual: readonly number[], expected: number[], digits = 9): void =>
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, digits));

describe('describe_scene / computeSceneSnapshot', () => {
  it('returns a read-only snapshot with singular/plural counts, layers, selection, groups and merged bounds', () => {
    const { doc } = build(['add_box', { size: [2, 2, 2], position: [0, 0, 0] }]);
    const r = execute(doc, 'describe_scene', {});
    expectNoOp(r, doc);
    expect(r.data).toMatchObject({ entityCount: 1, entities: [{ kind: 'box' }] });
    expect(r.summary).toContain('1 entity');
    expect(execute(createEmptyDocument(), 'describe_scene', {}).summary).toContain('0 entities');
    expect((r.data as Snap).entities[0]!.bounds.oriented).toBeUndefined();
    const grouped = groupedBoxes('Pair');
    const snap = computeSceneSnapshot({ ...grouped.doc, selection: [grouped.ids[0]!] });
    expect(snap.layers[0]!.entityCount).toBe(2);
    expect(snap.selection).toEqual([grouped.ids[0]]);
    expect(snap.groups.map((g) => g.name)).toEqual(['Pair']);
    expect(computeSceneSnapshot(createEmptyDocument()).bounds).toBeNull();
    const pair = build(['add_box', { size: [2, 2, 2], position: [0, 0, 0] }], ['add_box', { size: [2, 2, 2], position: [10, 0, 0] }]).doc;
    expect(computeSceneSnapshot(pair).bounds).toEqual({ min: [-1, -1, -1], max: [11, 1, 1] });
  });
});

describe('entityBounds — per kind', () => {
  it.each<[string, () => Entity, number[], number[]]>([
    ['box', () => only('add_box', { size: [4, 6, 8], position: [1, 1, 1] }), [-1, -2, -3], [3, 4, 5]],
    ['cylinder (Z-up)', () => only('add_cylinder', { radius: 2, height: 10, position: [0, 0, 0] }), [-2, -2, -5], [2, 2, 5]],
    ['sphere', () => only('add_sphere', { radius: 3, position: [1, 0, 0] }), [-2, -3, -3], [4, 3, 3]],
    ['extrusion', () => only('extrude_profile', { profile: xy(0, 0, 4, 0, 4, 2, 0, 2), depth: 5 }), [0, 0, 0], [4, 2, 5]],
    ['empty extrusion', () => raw({ kind: 'extrusion', profile: [], depth: 3, position: [2, 2, 0] }), [2, 2, 0], [2, 2, 3]],
    [
      'mesh (world-space vertices)',
      () => raw({ kind: 'mesh', mesh: { positions: [0, 0, 0, 2, 3, 4, -1, -1, -1], indices: [0, 1, 2] } }),
      [-1, -1, -1],
      [2, 3, 4],
    ],
    ['empty mesh', () => raw({ kind: 'mesh', mesh: { positions: [], indices: [] }, position: [5, 5, 5] }), [5, 5, 5], [5, 5, 5]],
    ['line', () => only('draw_polyline', { points: xy(1, 1, 4, 5), position: [1, 0, 0] }), [2, 1, 0], [5, 5, 0]],
    ['polyline', () => only('draw_polyline', { points: xy(0, 0, 3, 1, 1, 4) }), [0, 0, 0], [3, 4, 0]],
    ['empty polyline', () => raw({ kind: 'polyline', points: [], closed: false, position: [7, 8, 9] }), [7, 8, 9], [7, 8, 9]],
    ['circle', () => only('draw_arc', { center: [2, 2], radius: 3 }), [-1, -1, 0], [5, 5, 0]],
    [
      'arc (conservative)',
      () => only('draw_arc', { center: [0, 0], radius: 2, startAngle: 0, endAngle: Math.PI / 2 }),
      [-2, -2, 0],
      [2, 2, 0],
    ],
    ['rectangle', () => only('draw_rectangle', { width: 4, height: 2, position: [1, 1, 0] }), [1, 1, 0], [5, 3, 0]],
    ['point', () => only('draw_point', { position: [3, 4, 5] }), [3, 4, 5], [3, 4, 5]],
    ['instance without a doc', () => raw({ kind: 'instance', componentId: 'comp-x', position: [3, 7, 2] }), [3, 7, 2], [3, 7, 2]],
  ])('%s', (_, make, min, max) => expect(entityBounds(make())).toEqual({ min, max }));
});

describe('rotatedEntityBounds', () => {
  const rotated = (name: string, p: object, delta: [number, number, number]): { doc: CadDocument; e: Entity } => {
    const a = build([name, { ...p, position: [0, 0, 0] }]);
    const doc = execute(a.doc, 'rotate_entity', { id: a.ids[0], delta }).document;
    return { doc, e: doc.entities[a.ids[0]!]! };
  };

  it.each([
    ['add_box', { size: [4, 6, 8], position: [1, 1, 1] }],
    ['add_cylinder', { radius: 2, height: 10, position: [0, 0, 0] }],
  ])('%s with zero rotation equals entityBounds, without the oriented flag', (name, p) => {
    const e = only(name, p);
    expect(rotatedEntityBounds(e)).toEqual(entityBounds(e));
    expect(rotatedEntityBounds(e).oriented).toBeUndefined();
  });

  it('rotations swap or grow extents (box, cylinder) and flag oriented:true', () => {
    const tall = rotatedEntityBounds(rotated('add_box', { size: [2, 2, 10] }, [Math.PI / 2, 0, 0]).e);
    expect(tall.oriented).toBe(true);
    close([tall.min[0], tall.max[0], tall.min[1], tall.max[1]], [-1, 1, -5, 5]);
    expect(Math.abs(tall.max[2] - tall.min[2])).toBeCloseTo(2, 1);
    const { e } = rotated('add_box', { size: [4, 2, 2] }, [0, 0, Math.PI / 4]);
    const obb = rotatedEntityBounds(e);
    const plain = entityBounds({ ...e, rotation: [0, 0, 0] });
    expect(obb.max[0] - obb.min[0]).toBeGreaterThan(plain.max[0] - plain.min[0] - 1e-9);
    expect(obb.max[1] - obb.min[1]).toBeGreaterThan(plain.max[1] - plain.min[1] - 1e-9);
    expect(obb.max[2] - obb.min[2]).toBeCloseTo(plain.max[2] - plain.min[2], 9);
    const thin = rotated('add_box', { size: [1, 1, 10] }, [Math.PI / 2, 0, 0]).e;
    expect(rotatedEntityBounds(thin).max[2]).toBeLessThan(entityBounds(thin).max[2] - 1);
    const cyl = rotatedEntityBounds(rotated('add_cylinder', { radius: 2, height: 10 }, [Math.PI / 2, 0, 0]).e);
    expect(cyl.oriented).toBe(true);
    close([cyl.min[0], cyl.max[0]], [-2, 2]);
    expect(cyl.max[2] - cyl.min[2]).toBeLessThan(cyl.max[1] - cyl.min[1]);
    const snap = execute(rotated('add_box', { size: [1, 1, 4] }, [Math.PI / 4, 0, 0]).doc, 'describe_scene', {}).data as Snap;
    expect(snap.entities[0]!.bounds.oriented).toBe(true);
  });

  it('a rotated, moved mesh is rotated about the origin then translated, like the viewport and the kernel place it', () => {
    const positions = [3, -1, -1, 5, -1, -1, 5, 1, -1, 3, 1, -1, 3, -1, 1, 5, -1, 1, 5, 1, 1, 3, 1, 1];
    const b = rotatedEntityBounds(
      raw({ kind: 'mesh', mesh: { positions, indices: [0, 1, 2] }, position: [4, 0, 0], rotation: [0, 0, Math.PI] }),
    );
    expect(b.oriented).toBe(true);
    // x ∈ [3, 5] turned by π about Z → [-5, -3], then +4 → [-1, 1]
    close([...b.min, ...b.max], [-1, -1, -1, 1, 1, 1]);
  });
});

describe('instanceBoundsFromDoc', () => {
  it('expands the component geometry; a missing component degenerates to the instance position', () => {
    const a = build(['add_box', { size: [2, 2, 2], position: [0, 0, 0] }]);
    const doc = execute(a.doc, 'create_component', { entityIds: a.ids, name: 'MyBox' }).document;
    const instance = doc.entities[doc.order[0]!]!;
    expect(instance.kind).toBe('instance');
    const b = instanceBoundsFromDoc(instance as Parameters<typeof instanceBoundsFromDoc>[0], doc);
    close([...b.min, ...b.max], [-1, -1, -1, 1, 1, 1], 5);
    const fake = raw({ kind: 'instance', componentId: 'comp-missing', position: [5, 5, 5] });
    expect(instanceBoundsFromDoc(fake as Parameters<typeof instanceBoundsFromDoc>[0], createEmptyDocument())).toEqual({
      min: [5, 5, 5],
      max: [5, 5, 5],
    });
  });

  it('describe_scene reports a non-degenerate instance AABB', () => {
    const a = build(['add_box', { size: [4, 4, 4], position: [10, 0, 0] }]);
    const snap = computeSceneSnapshot(execute(a.doc, 'create_component', { entityIds: a.ids, name: 'BigBox' }).document);
    expect(snap.entityCount).toBe(1);
    expect(snap.entities[0]!.bounds.max[0] - snap.entities[0]!.bounds.min[0]).toBeGreaterThan(3);
  });
});
