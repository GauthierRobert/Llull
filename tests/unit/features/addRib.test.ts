import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { thickenedPath } from '@core/geometry/featureRib';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { ctxWith, idOf, manifoldSuite, meshOf, plate, volumeOf } from '../../helpers/featureSupport';

manifoldSuite();

const PLANE = { origin: [0, 0, 10], normal: [0, 0, 1] };
const PATH = [
  [10, 30],
  [90, 30],
];

const rib = (params: Record<string, unknown>, stock = plate()): ReturnType<typeof execute> =>
  execute(stock.doc, 'add_rib', { target: stock.id, plane: PLANE, path: PATH, thickness: 3, height: 20, ...params });

describe('add_rib', () => {
  it('fuses a 3 x 20 rib onto the plate: volume = plate + thickness x length x height (VC-FTR-33 geometry)', () => {
    const stock = plate();
    const result = rib({}, stock);
    expect(result.rejected).toBeUndefined();
    const id = idOf(result);
    expect(result.document.order).toEqual([id]);
    expect(result.document.entities[stock.id]).toBeUndefined();
    expect(Math.abs(volumeOf(result.document, id) - (60000 + 3 * 80 * 20)) / 64800).toBeLessThan(1e-6);
    expect(meshOf(result.document, id).brep).toMatchObject({
      op: 'feature',
      feature: 'rib',
      rib: { thickness: 3, height: 20, symmetric: true },
    });
    expect(result.summary).toContain('add_rib');
  });

  it('mitres an L-shaped path (area = thickness x centre-line length) and honours one-sided thickness', () => {
    const bend = [
      [10, 10],
      [50, 10],
      [50, 40],
    ];
    const centred = rib({ path: bend });
    expect(Math.abs(volumeOf(centred.document, idOf(centred)) - (60000 + 3 * 70 * 20)) / 64200).toBeLessThan(1e-6);
    const sided = rib({ path: bend, symmetric: false, height: 5 });
    expect(Math.abs(volumeOf(sided.document, idOf(sided)) - (60000 + 5 * 3 * 67)) / 61005).toBeLessThan(1e-6);
  });

  it('raises a rib up to a parallel face above (upToFace)', () => {
    const stock = plate();
    const pocket = execute(stock.doc, 'add_pocket', {
      target: stock.id,
      face: { near: [50, 30, 10] },
      outline: { kind: 'rectangle', center: [50, 30], size: [60, 40] },
      depth: 4,
      cornerRadius: 0,
      floorFillet: 0,
    });
    const before = volumeOf(pocket.document, idOf(pocket));
    const result = execute(pocket.document, 'add_rib', {
      target: idOf(pocket),
      plane: { origin: [0, 0, 6], normal: [0, 0, 1] },
      path: PATH.map(([u]) => [u as number, 30]).map(([u, v]) => [(u as number) / 2 + 25, v as number]),
      thickness: 2,
      upToFace: { near: [5, 5, 10] },
    });
    expect(result.rejected).toBeUndefined();
    expect(meshOf(result.document, idOf(result)).brep).toMatchObject({ feature: 'rib', rib: { height: 4 } });
    expect(Math.abs(volumeOf(result.document, idOf(result)) - before - 2 * 40 * 4) / before).toBeLessThan(1e-6);
  });

  it('is pure and refuses with stable codes', () => {
    const stock = plate();
    expectPure(stock.doc, () => rib({}, stock));
    const refused = (params: Record<string, unknown>, code: string, path?: string): void => {
      const result = rib(params, stock);
      expectNoOp(result, stock.doc);
      expect(result.rejected).toBe(true);
      expect(result.error?.code).toBe(code);
      if (path !== undefined) expect(result.error?.paths).toContain(path);
    };
    refused({ plane: { origin: [0, 0, 5], normal: [0, 0, 1] } }, 'FTR_RIB_PATH_NOT_SUPPORTED', 'plane');
    refused({ plane: { origin: [0, 0, 10], normal: [0, 0, -1] } }, 'FTR_RIB_PATH_NOT_SUPPORTED', 'plane');
    refused(
      {
        path: [
          [10, 30],
          [120, 30],
        ],
      },
      'FTR_RIB_PATH_NOT_SUPPORTED',
      'path',
    );
    refused({ path: [[10, 30]] }, 'FTR_PROFILE_NOT_CLOSED', 'path');
    refused(
      {
        path: [
          [10, 30],
          [10, 30],
        ],
      },
      'FTR_PROFILE_NOT_CLOSED',
    );
    refused(
      {
        path: [
          [10, 30, 1],
          [20, 30],
        ],
      },
      'FTR_PROFILE_NOT_CLOSED',
    );
    refused({ height: undefined }, 'FTR_PARAM_INVALID', 'height');
    refused({ upToFace: { near: [5, 5, 0] } }, 'FTR_PARAM_INVALID', 'upToFace');
    refused({ height: undefined, upToFace: { near: [5, 5, 0] } }, 'FTR_UP_TO_TARGET_INVALID', 'upToFace.near');
    refused({ plane: { origin: [0, 0, 10], normal: [0, 0, 0] } }, 'FTR_PARAM_INVALID', 'plane.normal');
    refused(
      {
        plane: { origin: [500, 500, 500], normal: [0, 0, 1] },
        path: [
          [0, 0],
          [1, 0],
        ],
      },
      'FTR_RIB_PATH_NOT_SUPPORTED',
    );
    expect(execute(stock.doc, 'add_rib', { target: 'nope', plane: PLANE, path: PATH, thickness: 3, height: 5 }).error?.code).toBe(
      'FTR_FACE_NOT_FOUND',
    );
    const invalid = rib({ thickness: -1 }, stock);
    expectNoOp(invalid, stock.doc);
  });

  it('refuses a 2D target and a missing kernel', () => {
    const line = execute(plate().doc, 'draw_rectangle', { width: 5, height: 5 });
    const flat = execute(line.document, 'add_rib', { target: idOf(line), plane: PLANE, path: PATH, thickness: 3, height: 5 });
    expectNoOp(flat, line.document, 'not a 3D solid');
    const stock = plate();
    const offline = execute(stock.doc, 'add_rib', { target: stock.id, plane: PLANE, path: PATH, thickness: 3, height: 5 }, ctxWith(null));
    expectNoOp(offline, stock.doc);
  });
});

describe('thickenedPath', () => {
  it('returns a counter-clockwise polygon of the right area, or the reason', () => {
    const polygon = thickenedPath(
      [
        [0, 0],
        [10, 0],
      ],
      2,
      true,
    );
    expect(polygon).toEqual([
      [0, -1],
      [10, -1],
      [10, 1],
      [0, 1],
    ]);
    expect(thickenedPath([[0, 0]], 2, true)).toContain('at least 2');
    expect(
      thickenedPath(
        [
          [0, 0],
          [0, 0],
        ],
        2,
        true,
      ),
    ).toContain('zero-length');
    expect(
      thickenedPath(
        [
          [0, 0],
          [10, 0],
          [0, 0.5],
        ],
        2,
        true,
      ),
    ).toContain('too sharply');
    expect(
      thickenedPath(
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [5, 10],
          [5, -5],
        ],
        2,
        true,
      ),
    ).toContain('crosses itself');
  });
});
