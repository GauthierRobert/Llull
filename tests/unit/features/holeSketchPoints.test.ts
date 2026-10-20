import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { idOf, manifoldSuite, plate, volumeOf } from '../../helpers/featureSupport';

manifoldSuite();

const TOP = { near: [50, 30, 10] };
const MESH_TOLERANCE = 3e-3;
const HOLE = { kind: 'simple', diameter: 6 };
const THROUGH = { kind: 'through_all' };

/** A plate (100 x 60 x 10, top face z = 10) with a sketch on its top face: two point entities and a rectangle at z = 10. */
function sketched(): { doc: CadDocument; target: string; ids: string[] } {
  const stock = plate();
  let doc = stock.doc;
  const ids: string[] = [];
  for (const position of [
    [20, 15, 10],
    [80, 45, 10],
  ]) {
    const drawn = execute(doc, 'draw_point', { position });
    doc = drawn.document;
    ids.push(idOf(drawn));
  }
  const polyline = execute(doc, 'draw_polyline', {
    position: [0, 0, 10],
    points: [
      [20, 45],
      [50, 30],
      [80, 15],
    ],
  });
  ids.push(idOf(polyline));
  return { doc: polyline.document, target: stock.id, ids };
}

const drill = (doc: CadDocument, target: string, points: unknown): ReturnType<typeof execute> =>
  execute(doc, 'add_hole', { target, face: TOP, points, hole: HOLE, extent: THROUGH });

describe('add_hole at sketch points (SC-F2)', () => {
  it('drills at point entities: same result as the equivalent [x, y] points; the sketch is kept', () => {
    const { doc, target, ids } = sketched();
    const result = drill(doc, target, { sketchEntityIds: [ids[0] as string, ids[1] as string] });
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    const mesh = result.document.entities[idOf(result)] as MeshSolidEntity;
    expect(mesh.brep).toMatchObject({ op: 'feature', feature: 'hole' });
    const removed = 60000 - volumeOf(result.document, idOf(result));
    expect(Math.abs(removed - 2 * Math.PI * 9 * 10) / removed).toBeLessThan(MESH_TOLERANCE);
    expect(result.document.entities[ids[0] as string]).toBeDefined();
    const reference = execute(doc, 'add_hole', {
      target,
      face: TOP,
      pointsFrame: 'world_xy',
      points: [
        [20, 15],
        [80, 45],
      ],
      hole: HOLE,
      extent: THROUGH,
    });
    expect(volumeOf(result.document, idOf(result))).toBeCloseTo(volumeOf(reference.document, idOf(reference)), 6);
    expectPure(doc, () => drill(doc, target, { sketchEntityIds: [ids[0]] }));
  });

  it('a polyline gives all its vertices, pointRefs pick single vertices (both together add up)', () => {
    const { doc, target, ids } = sketched();
    const all = drill(doc, target, { sketchEntityIds: [ids[2] as string] });
    expect(60000 - volumeOf(all.document, idOf(all))).toBeGreaterThan(3 * Math.PI * 9 * 10 * (1 - MESH_TOLERANCE));
    const some = drill(doc, target, { pointRefs: [{ id: ids[2], vertex: 1 }], sketchEntityIds: [ids[0] as string] });
    const removed = 60000 - volumeOf(some.document, idOf(some));
    expect(Math.abs(removed - 2 * Math.PI * 9 * 10) / removed).toBeLessThan(MESH_TOLERANCE);
    expect((some.document.entities[idOf(some)] as MeshSolidEntity).brep).toMatchObject({
      points: [
        [expect.any(Number), expect.any(Number)],
        [expect.any(Number), expect.any(Number)],
      ],
    });
  });

  it('refuses a sketch point off the face plane, naming it and its distance', () => {
    const { doc, target } = sketched();
    const floating = execute(doc, 'draw_point', { position: [50, 30, 14] });
    const result = drill(floating.document, target, { sketchEntityIds: [idOf(floating)] });
    expectNoOp(result, floating.document, 'do not lie on the picked face plane');
    expect(result.summary).toContain(`${idOf(floating)}#0 (4 off the face plane)`);
    expect(result.error?.code).toBe('FTR_HOLE_POINT_OUTSIDE_FACE');
  });

  it('refuses a sketch point outside the face outline, unknown entities, kinds without points and bad vertices', () => {
    const { doc, target, ids } = sketched();
    const outside = execute(doc, 'draw_point', { position: [150, 30, 10] });
    expectNoOp(drill(outside.document, target, { sketchEntityIds: [idOf(outside)] }), outside.document, 'outside the picked face');
    expectNoOp(drill(doc, target, { sketchEntityIds: ['nope'] }), doc, "sketch entity 'nope' not found");
    expectNoOp(drill(doc, target, { sketchEntityIds: [target] }), doc, 'has no sketch points');
    expectNoOp(drill(doc, target, { pointRefs: [{ id: ids[2], vertex: 9 }] }), doc, 'vertex 9 does not exist');
    expectNoOp(drill(doc, target, {}), doc, 'at least one entry');
  });
});
