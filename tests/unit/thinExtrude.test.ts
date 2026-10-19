import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type ExtrusionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { polygonArea } from '@lib/polygon';
import { thinRegion } from '@core/geometry/thinProfile';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { idOf, manifoldSuite, volumeOf } from '../helpers/featureSupport';

const kernel = manifoldSuite();
const RECT: Array<[number, number]> = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
];
const L_PATH: Array<[number, number]> = [
  [0, 0],
  [10, 0],
  [10, 10],
];

describe('extrude_profile thin: open path -> band', () => {
  it('centre wall of an L path: band area = thickness x path length, extruded by depth', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'extrude_profile', { profile: L_PATH, openPath: true, depth: 5, thin: { thickness: 2, side: 'centre' } });
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    const band = result.document.entities[idOf(result)] as ExtrusionEntity;
    expect(band.kind).toBe('extrusion');
    expect(polygonArea(band.profile as Array<[number, number]>) * band.depth).toBeCloseTo(2 * 20 * 5, 9);
    expect(result.summary).toContain('wall area 40');
    expectPure(doc, () =>
      execute(doc, 'extrude_profile', { profile: L_PATH, openPath: true, depth: 5, thin: { thickness: 2, side: 'centre' } }),
    );
  });

  it('inside / outside put the whole wall on one side of the travel direction', () => {
    const inside = thinRegion(L_PATH, false, 2, 'inside');
    const outside = thinRegion(L_PATH, false, 2, 'outside');
    if (typeof inside === 'string' || typeof outside === 'string') throw new Error('region expected');
    expect(inside.kind).toBe('band');
    const xs = (region: typeof inside): number[] => (region.kind === 'band' ? region.polygon.map((p) => p[1]) : []);
    expect(Math.min(...xs(inside))).toBeCloseTo(0);
    expect(Math.max(...xs(inside))).toBeCloseTo(10);
    expect(Math.min(...xs(outside))).toBeCloseTo(-2);
  });

  it('an open polyline entity is thickened at its own position', () => {
    const drawn = execute(createEmptyDocument(), 'draw_polyline', { points: L_PATH, closed: false });
    const result = execute(drawn.document, 'extrude_profile', { id: idOf(drawn), depth: 3, thin: { thickness: 1, side: 'centre' } });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('open polyline');
  });

  it('refuses a wall so thick that the band self-intersects, and a path that doubles back', () => {
    const doc = createEmptyDocument();
    expectNoOp(
      execute(doc, 'extrude_profile', { profile: L_PATH, openPath: true, depth: 1, thin: { thickness: 30, side: 'inside' } }),
      doc,
      'self-intersect',
    );
    expectNoOp(
      execute(doc, 'extrude_profile', {
        profile: [
          [0, 0],
          [10, 0],
          [0, 0.5],
        ],
        openPath: true,
        depth: 1,
        thin: { thickness: 1, side: 'centre' },
      }),
      doc,
      'turns back',
    );
  });
});

describe('extrude_profile thin: closed profile -> ring (Manifold)', () => {
  it.each([
    ['inside', 20 * 10 - 16 * 6],
    ['centre', 22 * 12 - 18 * 8],
    ['outside', 24 * 14 - 20 * 10],
  ] as const)('%s wall of a rectangle: volume = ring area x depth', (side, area) => {
    setGeometryKernel(kernel());
    const doc = createEmptyDocument();
    const result = execute(doc, 'extrude_profile', { profile: RECT, depth: 4, thin: { thickness: 2, side } });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[idOf(result)]?.kind).toBe('mesh');
    expect(result.document.order).toEqual(result.affected);
    expect(volumeOf(result.document, idOf(result))).toBeCloseTo(area * 4, 6);
  });

  it('works on a drawn closed rectangle and keeps the source', () => {
    const drawn = execute(createEmptyDocument(), 'draw_rectangle', { corner: [0, 0], width: 20, height: 10 });
    const result = execute(drawn.document, 'extrude_profile', { id: idOf(drawn), depth: 4, thin: { thickness: 2, side: 'inside' } });
    expect(result.affected).toHaveLength(1);
    expect(Object.keys(result.document.entities)).toContain(idOf(drawn));
  });

  it('refuses a wall that fills the whole outline, bad depth / thickness and a missing kernel', () => {
    const doc = createEmptyDocument();
    expectNoOp(execute(doc, 'extrude_profile', { profile: RECT, depth: 4, thin: { thickness: 6, side: 'inside' } }), doc, 'too large');
    expectNoOp(execute(doc, 'extrude_profile', { profile: RECT, depth: 0, thin: { thickness: 1, side: 'inside' } }), doc, 'depth');
    expectNoOp(execute(doc, 'extrude_profile', { profile: RECT, depth: 1, thin: { thickness: -1, side: 'inside' } }), doc, 'thickness');
    expectNoOp(execute(doc, 'extrude_profile', { depth: 1, thin: { thickness: 1, side: 'inside' } }), doc, 'exactly one');
    setGeometryKernel(null);
    expectNoOp(execute(doc, 'extrude_profile', { profile: RECT, depth: 1, thin: { thickness: 1, side: 'inside' } }), doc);
    expectNoOp(execute(doc, 'extrude_profile', { profile: RECT, depth: 1, openPath: true }), doc, 'openPath needs thin');
  });
});
