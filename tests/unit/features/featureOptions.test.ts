/** Hole and pocket options of 07 FTR §3.1: counterdrill, up_to_next / up_to_face extents, pocket islands, upToFace and open. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { idOf, manifoldSuite, meshOf, plate, volumeOf } from '../../helpers/featureSupport';

manifoldSuite();

const TOP = { near: [50, 30, 10] };
const MESH_TOLERANCE = 3e-3;
const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / expected;

const drill = (params: Record<string, unknown>, stock = plate()): ReturnType<typeof execute> =>
  execute(stock.doc, 'add_hole', { target: stock.id, face: TOP, pointsFrame: 'world_xy', points: [[50, 30]], ...params });

/** 100 x 60 x 30 block with a 80 x 40 x 20 cavity between z = 5 and z = 25: the top wall is 5 thick, the floor 5. */
function hollowBlock(): { doc: ReturnType<typeof execute>['document']; id: string } {
  const outer = execute(createEmptyDocument(), 'add_box', { size: [100, 60, 30], position: [0, 0, 0], anchor: 'min' });
  const inner = execute(outer.document, 'add_box', { size: [80, 40, 20], position: [10, 10, 5], anchor: 'min' });
  const hollow = execute(inner.document, 'boolean', { op: 'subtract', a: idOf(outer), b: idOf(inner) });
  return { doc: hollow.document, id: idOf(hollow) };
}

describe('add_hole counterdrill', () => {
  const spec = { kind: 'counterdrill', diameter: 4, cboreDiameter: 8, cboreDepth: 4, cskDiameter: 10, cskAngle: 90 };

  it('cuts a countersink cone over a counterbore over the bore: closed-form volume', () => {
    const result = drill({ hole: spec, extent: { kind: 'through_all' } });
    expect(result.rejected).toBeUndefined();
    const [bore, cbore, cone] = [Math.PI * 4 * 10, Math.PI * (16 - 4) * 4, (Math.PI / 3) * (25 + 20 + 16) - Math.PI * 16];
    expect(relative(60000 - volumeOf(result.document, idOf(result)), bore + cbore + cone)).toBeLessThan(MESH_TOLERANCE);
    expect(meshOf(result.document, idOf(result)).brep).toMatchObject({ hole: { kind: 'counterdrill', cskDiameter: 10 } });
    expect(result.summary).toContain('counterdrill');
  });

  it('accepts cskDepth for the cone and refuses inconsistent specs', () => {
    const stock = plate();
    const byDepth = drill({ hole: { ...spec, cskDiameter: undefined, cskDepth: 1 }, extent: { kind: 'through_all' } }, stock);
    expect(byDepth.rejected).toBeUndefined();
    const refused = (hole: Record<string, unknown>, code: string): void => {
      const result = drill({ hole: { ...spec, ...hole }, extent: { kind: 'through_all' } }, stock);
      expectNoOp(result, stock.doc);
      expect(result.error?.code).toBe(code);
    };
    refused({ cskDiameter: 7 }, 'FTR_HOLE_DIAMETERS_INCONSISTENT');
    refused({ cboreDiameter: 3 }, 'FTR_HOLE_DIAMETERS_INCONSISTENT');
    refused({ cboreDepth: 0.5 }, 'FTR_HOLE_DIAMETERS_INCONSISTENT');
    refused({ cskDiameter: undefined }, 'FTR_HOLE_DIAMETERS_INCONSISTENT');
    refused({ cskAngle: 200 }, 'FTR_CSK_ANGLE_OUT_OF_RANGE');
    refused({ cskAngle: undefined }, 'FTR_CSK_ANGLE_OUT_OF_RANGE');
  });
});

describe('add_hole up_to_next / up_to_face', () => {
  it('up_to_next cuts the first wall only and stores the measured depth', () => {
    const block = hollowBlock();
    const result = drill(
      { hole: { kind: 'simple', diameter: 6 }, extent: { kind: 'up_to_next' }, face: { near: [50, 30, 30] } },
      { ...block },
    );
    expect(result.rejected).toBeUndefined();
    const id = idOf(result);
    const before = volumeOf(block.doc, block.id);
    expect(relative(before - volumeOf(result.document, id), Math.PI * 9 * 5)).toBeLessThan(MESH_TOLERANCE);
    expect(meshOf(result.document, id).brep).toMatchObject({ extent: { kind: 'up_to_next' } });
    expect(result.summary).toContain('up to next');
  });

  it('up_to_next groups holes with different wall depths into separate nodes', () => {
    const block = hollowBlock();
    const result = drill(
      {
        hole: { kind: 'simple', diameter: 4 },
        extent: { kind: 'up_to_next' },
        face: { near: [50, 30, 30] },
        points: [
          [30, 30],
          [95, 30],
        ],
      },
      block,
    );
    expect(result.rejected).toBeUndefined();
    const brep = meshOf(result.document, idOf(result)).brep as { source: { extent: { depth: number } }; extent: { depth: number } };
    expect([brep.source.extent.depth, brep.extent.depth].sort((a, b) => a - b)).toEqual([5, 30]);
  });

  it('up_to_face stops at the plane of a parallel face below (flat bottom)', () => {
    const block = hollowBlock();
    const result = drill(
      { hole: { kind: 'simple', diameter: 6 }, extent: { kind: 'up_to_face', face: { near: [50, 30, 5] } }, face: { near: [50, 30, 30] } },
      block,
    );
    expect(result.rejected).toBeUndefined();
    const removed = volumeOf(block.doc, block.id) - volumeOf(result.document, idOf(result));
    expect(relative(removed, Math.PI * 9 * 5)).toBeLessThan(MESH_TOLERANCE);
    expect(meshOf(result.document, idOf(result)).brep).toMatchObject({ extent: { kind: 'up_to_face', depth: 25 } });
  });

  it('refuses unresolvable targets with FTR_UP_TO_TARGET_INVALID and misuse with FTR_BLIND_DEPTH_INVALID', () => {
    const stock = plate();
    const refused = (
      extent: Record<string, unknown>,
      code: string,
      hole: Record<string, unknown> = { kind: 'simple', diameter: 4 },
    ): void => {
      const result = drill({ hole, extent }, stock);
      expectNoOp(result, stock.doc);
      expect(result.error?.code).toBe(code);
    };
    refused({ kind: 'up_to_face' }, 'FTR_UP_TO_TARGET_INVALID');
    refused({ kind: 'up_to_face', face: { near: [50, 30, 10] } }, 'FTR_UP_TO_TARGET_INVALID');
    refused({ kind: 'up_to_face', face: { near: [100, 30, 5] } }, 'FTR_UP_TO_TARGET_INVALID');
    refused({ kind: 'up_to_face', face: { near: [500, 500, 500] } }, 'FTR_UP_TO_TARGET_INVALID');
    refused({ kind: 'up_to_face', face: { near: [50, 30, 0] }, depth: 3 }, 'FTR_BLIND_DEPTH_INVALID');
    refused({ kind: 'up_to_next', drillPointAngle: 118 }, 'FTR_BLIND_DEPTH_INVALID');
    refused({ kind: 'up_to_face', face: { near: [50, 30, 0] } }, 'FTR_BLIND_DEPTH_INVALID', {
      kind: 'counterbore',
      diameter: 4,
      cboreDiameter: 8,
      cboreDepth: 12,
    });
    expectPure(stock.doc, () =>
      drill({ hole: { kind: 'simple', diameter: 4 }, extent: { kind: 'up_to_face', face: { near: [50, 30, 0] } } }, stock),
    );
  });
});

describe('add_pocket islands, upToFace and open', () => {
  const pocket = (params: Record<string, unknown>, stock = plate()): ReturnType<typeof execute> =>
    execute(stock.doc, 'add_pocket', {
      target: stock.id,
      face: TOP,
      outline: { kind: 'rectangle', center: [50, 30], size: [40, 20] },
      depth: 4,
      cornerRadius: 0,
      floorFillet: 0,
      ...params,
    });
  const island = [
    [45, 27],
    [55, 27],
    [55, 33],
    [45, 33],
  ];

  it('leaves islands standing: removed = (outline area - island area) x depth, also with rounded corners', () => {
    for (const cornerRadius of [0, 2]) {
      const result = pocket({ islands: [island], cornerRadius });
      expect(result.rejected).toBeUndefined();
      expect(relative(60000 - volumeOf(result.document, idOf(result)), (800 - 60) * 4)).toBeLessThan(MESH_TOLERANCE);
    }
  });

  it('records the islands in the feature node and keeps two islands apart', () => {
    const second = island.map(([u, v]) => [(u as number) - 12, v as number]);
    const result = pocket({ islands: [island, second] });
    expect(result.rejected).toBeUndefined();
    expect(meshOf(result.document, idOf(result)).brep).toMatchObject({ pocket: { islands: [expect.any(Array), expect.any(Array)] } });
    expect(relative(60000 - volumeOf(result.document, idOf(result)), (800 - 120) * 4)).toBeLessThan(MESH_TOLERANCE);
  });

  it('refuses malformed, escaping and overlapping islands with FTR_POCKET_ISLAND_INVALID', () => {
    const stock = plate();
    const refused = (islands: unknown): void => {
      const result = pocket({ islands }, stock);
      expectNoOp(result, stock.doc);
      expect(result.error?.code).toBe('FTR_POCKET_ISLAND_INVALID');
      expect(result.error?.paths.some((path) => path.startsWith('islands.'))).toBe(true);
    };
    refused([
      [
        [45, 27],
        [55, 27],
      ],
    ]);
    refused([
      [
        [45, 27],
        [55, 33],
        [55, 27],
        [45, 33],
      ],
    ]);
    refused([
      [
        [45, 27],
        [75, 27],
        [75, 33],
        [45, 33],
      ],
    ]);
    refused([
      [
        [100, 100],
        [110, 100],
        [110, 110],
      ],
    ]);
    refused([island, island.map(([u, v]) => [(u as number) + 3, v as number])]);
    refused([
      [
        [45, 27, 1],
        [55, 27, 1],
        [55, 33, 1],
      ],
    ]);
    const tooBig = pocket({ islands: [island], cornerRadius: 4 }, stock);
    expect(tooBig.error?.code).toBe('FTR_POCKET_CORNER_TOO_LARGE');
  });

  it('upToFace resolves the floor from a parallel face below', () => {
    const first = pocket({ outline: { kind: 'rectangle', center: [20, 30], size: [30, 20] }, depth: 4 });
    const stock = { doc: first.document, id: idOf(first) };
    const result = pocket(
      { outline: { kind: 'rectangle', center: [75, 30], size: [30, 20] }, depth: undefined, upToFace: { near: [20, 30, 6] } },
      stock,
    );
    expect(result.rejected).toBeUndefined();
    expect(meshOf(result.document, idOf(result)).brep).toMatchObject({ feature: 'pocket', pocket: { depth: expect.closeTo(4, 9) } });
    expect(relative(60000 - volumeOf(result.document, idOf(result)), 2 * 600 * 4)).toBeLessThan(MESH_TOLERANCE);
    const wrong = pocket({ depth: undefined, upToFace: { near: [20, 30, 10] } }, stock);
    expect(wrong.error?.code).toBe('FTR_UP_TO_TARGET_INVALID');
    expect(wrong.error?.paths).toContain('upToFace.near');
    const two = pocket({ upToFace: { near: [20, 30, 6] } }, stock);
    expect(two.error?.code).toBe('FTR_POCKET_DEPTH_EXCEEDS_STOCK');
  });

  it('open pockets may leave the face; without open they are refused, and they must still overlap the face', () => {
    const overhang = { kind: 'rectangle', center: [95, 30], size: [20, 20] };
    const stock = plate();
    const closed = pocket({ outline: overhang }, stock);
    expectNoOp(closed, stock.doc);
    expect(closed.error?.code).toBe('FTR_HOLE_POINT_OUTSIDE_FACE');
    const open = pocket({ outline: overhang, open: true }, stock);
    expect(open.rejected).toBeUndefined();
    expect(relative(60000 - volumeOf(open.document, idOf(open)), 15 * 20 * 4)).toBeLessThan(MESH_TOLERANCE);
    const away = pocket({ outline: { kind: 'rectangle', center: [150, 30], size: [20, 20] }, open: true }, stock);
    expect(away.error?.code).toBe('FTR_HOLE_POINT_OUTSIDE_FACE');
  });
});
