import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { pocketRemovedVolume } from '@lib/holeMath';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { idOf, manifoldSuite, meshOf, plate, volumeOf } from '../../helpers/featureSupport';

manifoldSuite();

const TOP = { near: [50, 30, 10] };
const RECT = { kind: 'rectangle', center: [50, 45], size: [40, 12] };
const MESH_TOLERANCE = 3e-3;

const pocket = (params: Record<string, unknown>, stock = plate()): ReturnType<typeof execute> =>
  execute(stock.doc, 'add_pocket', { target: stock.id, face: TOP, outline: RECT, depth: 4, cornerRadius: 3, floorFillet: 0, ...params });

describe('add_pocket', () => {
  it('cuts a rounded rectangle pocket: removed volume matches the closed form (VC-FTR-27 PK-01 geometry)', () => {
    const result = pocket({});
    expect(result.rejected).toBeUndefined();
    const id = idOf(result);
    const removed = 60000 - volumeOf(result.document, id);
    const analytic = pocketRemovedVolume(40, 12, 4, 3, 0).value;
    expect(Math.abs(removed - analytic) / analytic).toBeLessThan(MESH_TOLERANCE);
    expect(meshOf(result.document, id).brep).toMatchObject({
      op: 'feature',
      feature: 'pocket',
      pocket: { depth: 4, cornerRadius: 3, floorFillet: 0 },
    });
    expect(result.document.order).toEqual([id]);
    expect(result.summary).toContain('add_pocket');
  });

  it('PK-01 sizes: 40 x 20 pocket depth 5 radius 4', () => {
    const result = pocket({ outline: { kind: 'rectangle', center: [50, 30], size: [40, 20] }, depth: 5, cornerRadius: 4 });
    const analytic = pocketRemovedVolume(40, 20, 5, 4, 0).value;
    expect(analytic).toBeCloseTo(3931.327412287, 6);
    expect(Math.abs(60000 - volumeOf(result.document, idOf(result)) - analytic) / analytic).toBeLessThan(MESH_TOLERANCE);
  });

  it('accepts a polygon outline and a through pocket', () => {
    const triangle = {
      kind: 'polygon',
      points: [
        [20, 20],
        [60, 20],
        [40, 50],
      ],
    };
    const result = pocket({ outline: triangle, cornerRadius: 0, through: true, depth: undefined });
    expect(result.rejected).toBeUndefined();
    const area = (40 * 30) / 2;
    expect(Math.abs(60000 - volumeOf(result.document, idOf(result)) - area * 10) / (area * 10)).toBeLessThan(1e-6);
  });

  it('is pure; the floor fillet needs an exact kernel (Manifold refuses with FTR_NEEDS_EXACT_KERNEL)', () => {
    const stock = plate();
    expectPure(stock.doc, () => pocket({}, stock));
    const result = pocket({ floorFillet: 1.5 }, stock);
    expectNoOp(result, stock.doc);
    expect(result.error?.code).toBe('FTR_NEEDS_EXACT_KERNEL');
  });

  it('refuses with stable codes', () => {
    const stock = plate();
    const refused = (params: Record<string, unknown>, code: string, path?: string): void => {
      const result = pocket(params, stock);
      expectNoOp(result, stock.doc);
      expect(result.rejected).toBe(true);
      expect(result.error?.code).toBe(code);
      if (path !== undefined) expect(result.error?.paths).toContain(path);
    };
    refused({ cornerRadius: 1, floorFillet: 1.5 }, 'FTR_POCKET_FILLET_GT_CORNER', 'floorFillet');
    refused({ depth: 10 }, 'FTR_POCKET_DEPTH_EXCEEDS_STOCK', 'depth');
    refused({ depth: undefined }, 'FTR_POCKET_DEPTH_EXCEEDS_STOCK');
    refused({ through: true }, 'FTR_POCKET_DEPTH_EXCEEDS_STOCK');
    refused(
      {
        outline: {
          kind: 'polygon',
          points: [
            [0, 0],
            [10, 0],
          ],
        },
      },
      'FTR_PROFILE_NOT_CLOSED',
      'outline',
    );
    refused(
      {
        outline: {
          kind: 'polygon',
          points: [
            [10, 10],
            [50, 40],
            [50, 10],
            [10, 40],
          ],
        },
        cornerRadius: 0,
      },
      'FTR_PROFILE_NOT_CLOSED',
    );
    refused({ outline: { kind: 'rectangle', center: [50, 45] } }, 'FTR_PROFILE_NOT_CLOSED');
    refused(
      { outline: { kind: 'rectangle', center: [50, 45], size: [40, 12] }, cornerRadius: 7 },
      'FTR_POCKET_CORNER_TOO_LARGE',
      'cornerRadius',
    );
    refused({ outline: { kind: 'rectangle', center: [95, 30], size: [40, 12] } }, 'FTR_HOLE_POINT_OUTSIDE_FACE', 'outline');
    refused({ face: { near: [50, 30, 400] } }, 'FTR_FACE_NOT_FOUND', 'face.near');
  });

  it('no-ops on a missing or flat target', () => {
    const stock = plate();
    const missing = execute(stock.doc, 'add_pocket', {
      target: 'nope',
      face: TOP,
      outline: RECT,
      depth: 1,
      cornerRadius: 0,
      floorFillet: 0,
    });
    expect(missing.error?.code).toBe('FTR_FACE_NOT_FOUND');
    const line = execute(stock.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    const flat = execute(line.document, 'add_pocket', {
      target: idOf(line),
      face: TOP,
      outline: RECT,
      depth: 1,
      cornerRadius: 0,
      floorFillet: 0,
    });
    expectNoOp(flat, line.document, 'not a 3D solid');
  });
});
