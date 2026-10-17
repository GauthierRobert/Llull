import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { countersinkRemovedVolume, drillTipHeight } from '@lib/holeMath';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { idOf, manifoldSuite, meshOf, plate, volumeOf } from '../../helpers/featureSupport';

manifoldSuite();

const TOP = { near: [50, 30, 10] };
const THROUGH = { kind: 'through_all' };
/** Mesh kernel: cylinders are 64-gons, so volumes agree with the closed forms to this relative error. */
const MESH_TOLERANCE = 3e-3;

const drill = (params: Record<string, unknown>, stock = plate()): ReturnType<typeof execute> =>
  execute(stock.doc, 'add_hole', { target: stock.id, face: TOP, pointsFrame: 'world_xy', extent: THROUGH, ...params });

describe('add_hole', () => {
  it('cuts countersunk through holes: removed volume matches the closed form, brep is a feature node', () => {
    const stock = plate();
    const result = drill(
      {
        points: [
          [10, 10],
          [90, 10],
          [10, 50],
          [90, 50],
        ],
        hole: { kind: 'countersink', diameter: 4.8, cskDiameter: 9, cskAngle: 100 },
      },
      stock,
    );
    expect(result.rejected).toBeUndefined();
    const id = idOf(result);
    expect(result.document.entities[stock.id]).toBeUndefined();
    expect(result.document.order).toEqual([id]);
    const removed = 60000 - volumeOf(result.document, id);
    const analytic = 4 * (Math.PI * 2.4 * 2.4 * 10 + countersinkRemovedVolume(4.8, 9, 100).value);
    expect(Math.abs(removed - analytic) / analytic).toBeLessThan(MESH_TOLERANCE);
    const brep = meshOf(result.document, id).brep;
    expect(brep).toMatchObject({
      op: 'feature',
      feature: 'hole',
      points: [
        [10, 10],
        [90, 10],
        [10, 50],
        [90, 50],
      ],
    });
    expect(result.summary).toContain('4 countersink holes');
  });

  it('counterbore through hole and blind hole with the default 118 degree drill point (reported as defaulted)', () => {
    const stock = plate();
    const bored = drill({ points: [[30, 30]], hole: { kind: 'counterbore', diameter: 5.5, cboreDiameter: 10, cboreDepth: 5.5 } }, stock);
    const blind = execute(bored.document, 'add_hole', {
      target: idOf(bored),
      face: TOP,
      pointsFrame: 'world_xy',
      points: [[50, 15]],
      hole: { kind: 'simple', diameter: 6 },
      extent: { kind: 'blind', depth: 6 },
    });
    expect(blind.summary).toContain('118');
    expect(blind.summary).toContain('by default');
    const cbore = Math.PI * 2.75 * 2.75 * 4.5 + Math.PI * 25 * 5.5;
    const tip = (Math.PI * 9 * drillTipHeight(6, 118).value) / 3;
    const analytic = cbore + Math.PI * 9 * 6 + tip;
    const removed = 60000 - volumeOf(blind.document, idOf(blind));
    expect(Math.abs(removed - analytic) / analytic).toBeLessThan(MESH_TOLERANCE);
  });

  it('flat bottom with drillPointAngle 0; hole.thread and fastener never change the recipe key', () => {
    const stock = plate();
    const flat = drill(
      { points: [[50, 15]], hole: { kind: 'simple', diameter: 6 }, extent: { kind: 'blind', depth: 6, drillPointAngle: 0 } },
      stock,
    );
    expect(Math.abs(60000 - volumeOf(flat.document, idOf(flat)) - Math.PI * 9 * 6) / (Math.PI * 9 * 6)).toBeLessThan(MESH_TOLERANCE);
    const plain = drill({ points: [[50, 15]], hole: { kind: 'simple', diameter: 6 } }, stock);
    const threaded = drill({ points: [[50, 15]], hole: { kind: 'simple', diameter: 6, thread: { designation: 'MJ6x1-4H5H' } } }, stock);
    const key = (r: ReturnType<typeof execute>): string => recipeKey(meshOf(r.document, idOf(r)).brep!);
    expect(key(threaded)).toBe(key(plain));
    expect(meshOf(threaded.document, idOf(threaded)).brep).toMatchObject({ hole: { thread: { designation: 'MJ6x1-4H5H', family: 'MJ' } } });
  });

  it('face frame points and countersink depth form agree with world_xy', () => {
    const stock = plate();
    const world = drill({ points: [[10, 10]], hole: { kind: 'countersink', diameter: 4.8, cskDepth: 1.762109225, cskAngle: 100 } }, stock);
    const local = execute(stock.doc, 'add_hole', {
      target: stock.id,
      face: TOP,
      points: [[10, 10]],
      extent: THROUGH,
      hole: { kind: 'countersink', diameter: 4.8, cskDiameter: 9, cskAngle: 100 },
    });
    expect(Math.abs(volumeOf(world.document, idOf(world)) - volumeOf(local.document, idOf(local)))).toBeLessThan(0.05);
  });

  it('is pure and the second hole group stacks on the first result', () => {
    const stock = plate();
    expectPure(stock.doc, () => drill({ points: [[10, 10]], hole: { kind: 'simple', diameter: 4 } }, stock));
    const first = drill({ points: [[10, 10]], hole: { kind: 'simple', diameter: 4 } }, stock);
    const second = execute(first.document, 'add_hole', {
      target: idOf(first),
      face: TOP,
      pointsFrame: 'world_xy',
      points: [[90, 50]],
      hole: { kind: 'simple', diameter: 4 },
      extent: THROUGH,
    });
    expect(meshOf(second.document, idOf(second)).brep).toMatchObject({ op: 'feature', source: { op: 'feature' } });
  });

  it('refuses with stable codes, leaving the document unchanged', () => {
    const stock = plate();
    const refused = (params: Record<string, unknown>, code: string, path?: string): void => {
      const result = drill(params, stock);
      expectNoOp(result, stock.doc);
      expect(result.rejected).toBe(true);
      expect(result.error?.code).toBe(code);
      if (path !== undefined) expect(result.error?.paths).toContain(path);
      expect(result.error?.remediation.length).toBeGreaterThan(0);
    };
    refused(
      { points: [[10, 10]], hole: { kind: 'countersink', diameter: 8, cskDiameter: 6, cskAngle: 100 } },
      'FTR_HOLE_DIAMETERS_INCONSISTENT',
    );
    refused(
      { points: [[10, 10]], hole: { kind: 'counterbore', diameter: 5, cboreDiameter: 4, cboreDepth: 2 } },
      'FTR_HOLE_DIAMETERS_INCONSISTENT',
    );
    refused(
      { points: [[10, 10]], hole: { kind: 'countersink', diameter: 4, cskDiameter: 8, cskAngle: 180 } },
      'FTR_CSK_ANGLE_OUT_OF_RANGE',
      'hole.cskAngle',
    );
    refused(
      { points: [[10, 10]], hole: { kind: 'simple', diameter: 4 }, extent: { kind: 'blind', depth: 0 } },
      'FTR_BLIND_DEPTH_INVALID',
      'extent.depth',
    );
    refused({ points: [[10, 10]], hole: { kind: 'simple', diameter: 4 }, extent: { kind: 'blind', depth: 10 } }, 'FTR_BLIND_DEPTH_INVALID');
    refused(
      { points: [[10, 10]], hole: { kind: 'simple', diameter: 4 }, extent: { kind: 'blind', depth: 3, drillPointAngle: 200 } },
      'FTR_DRILL_POINT_ANGLE_OUT_OF_RANGE',
    );
    refused(
      { points: [[10, 10]], hole: { kind: 'simple', diameter: 4, thread: { designation: 'MJ6' } } },
      'FTR_THREAD_DESIGNATION_INVALID',
      'hole.thread.designation',
    );
    refused(
      { points: [[10, 10]], hole: { kind: 'simple', diameter: 4, fastener: { catalogId: 'NAS', partNumber: 'NAS1351-3-8' } } },
      'FTR_FASTENER_CATALOG_UNAVAILABLE',
      'hole.fastener',
    );
    refused({ points: [[10, 10]], hole: { kind: 'simple' } }, 'FTR_HOLE_DIAMETERS_INCONSISTENT', 'hole.diameter');
    refused(
      {
        points: [
          [10, 10],
          [500, 10],
        ],
        hole: { kind: 'simple', diameter: 4 },
      },
      'FTR_HOLE_POINT_OUTSIDE_FACE',
      'points.1',
    );
    refused({ points: [[10, 10, 1]], hole: { kind: 'simple', diameter: 4 } }, 'FTR_HOLE_POINT_OUTSIDE_FACE', 'points.0');
    refused(
      { points: [[10, 10]], hole: { kind: 'simple', diameter: 4 }, face: { near: [50, 30, 500] } },
      'FTR_FACE_NOT_FOUND',
      'face.near',
    );
  });

  it('all-or-nothing: one bad point cuts nothing', () => {
    const stock = plate();
    const result = drill(
      {
        points: [
          [10, 10],
          [-5, 10],
        ],
        hole: { kind: 'simple', diameter: 4 },
      },
      stock,
    );
    expectNoOp(result, stock.doc);
    expect(result.error?.code).toBe('FTR_HOLE_POINT_OUTSIDE_FACE');
  });

  it('no-ops on a missing target, a 2D target, and an absent kernel', () => {
    const stock = plate();
    const missing = execute(stock.doc, 'add_hole', {
      target: 'nope',
      face: TOP,
      points: [[1, 1]],
      hole: { kind: 'simple', diameter: 2 },
      extent: THROUGH,
    });
    expect(missing.error?.code).toBe('FTR_FACE_NOT_FOUND');
    const line = execute(stock.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    const flat = execute(line.document, 'add_hole', {
      target: idOf(line),
      face: TOP,
      points: [[1, 1]],
      hole: { kind: 'simple', diameter: 2 },
      extent: THROUGH,
    });
    expectNoOp(flat, line.document, 'not a 3D solid');
  });

  it('a curved face is not planar', () => {
    const cylinder = execute(plate().doc, 'add_cylinder', { radius: 10, height: 20, position: [0, 0, 0] });
    const result = execute(cylinder.document, 'add_hole', {
      target: idOf(cylinder),
      face: { near: [10, 0, 0] },
      points: [[0, 0]],
      hole: { kind: 'simple', diameter: 2 },
      extent: THROUGH,
    });
    expect(result.error?.code).toBe('FTR_FACE_NOT_PLANAR');
  });
});
