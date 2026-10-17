import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal, meshBounds, meshVolume, ok } from './helpers';
import { plate } from './plates';

interface FlatData {
  extents: [number, number];
  area: number;
  bends: Array<{ id: string; angleDeg: number; direction: string }>;
}

const T = 1.6;
const R = 4.8;
const K = 0.44;
const BA90 = (Math.PI / 2) * (R + K * T);
const params = (part: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: part,
  edge: { near: [40, 15, 0] },
  side: 'bottom',
  path: [[0, 30]],
  ...extra,
});

describe('add_contour_flange (FR-FTR-13, VC-FTR-15)', () => {
  it('L profile develops to A + B - BD and equals the same add_flange to the outside mold line', () => {
    const { doc, part } = plate(40, 30);
    const result = ok(doc, 'add_contour_flange', params(part));
    expect(result.affected).toEqual([part]);
    const setback = R + T;
    const bd = 2 * setback - BA90;
    const flat = data<FlatData>(result.document, 'flat_pattern', { id: part });
    expect(flat.extents[0]).toBeCloseTo(40 + setback + 30 - bd, 9);
    const viaFlange = apply(doc, 'add_flange', {
      id: part,
      edge: { near: [40, 15, 0] },
      angle: 90,
      length: 30,
      lengthReference: 'outside_mold_line',
      position: 'material_outside',
    });
    expect(data<FlatData>(viaFlange, 'flat_pattern', { id: part }).extents[0]).toBeCloseTo(flat.extents[0], 9);
    expect((result.data as { developedLength: number }).developedLength).toBeCloseTo(30 - setback + BA90, 9);
  });

  it('Z profile on the mid line: legs are segments minus setbacks, bends up then down, analytic developed length', () => {
    const { doc, part } = plate(40, 30);
    const result = ok(
      doc,
      'add_contour_flange',
      params(part, {
        side: 'mid',
        path: [
          [0, 20],
          [15, 20],
        ],
      }),
    );
    const mid = R + T / 2;
    const info = result.data as { legs: number[]; turnsDeg: number[]; bends: string[] };
    expect(info.legs[0]).toBeCloseTo(20 - 2 * mid, 9);
    expect(info.legs[1]).toBeCloseTo(15 - mid, 9);
    expect(info.turnsDeg[0]).toBeCloseTo(90, 9);
    expect(info.turnsDeg[1]).toBeCloseTo(-90, 9);
    const flat = data<FlatData>(result.document, 'flat_pattern', { id: part });
    const ba = (Math.PI / 2) * (R + K * T);
    expect(flat.extents[0]).toBeCloseTo(40 + 2 * ba + (20 - 2 * mid) + (15 - mid), 9);
    expect(flat.extents[1]).toBeCloseTo(30, 9);
    expect(flat.bends.map((bend) => bend.direction)).toEqual(['up', 'down']);
    const bounds = meshBounds(result.document, part);
    expect(bounds.max[2]).toBeCloseTo(T / 2 + 20 + T / 2, 6);
    expect(bounds.max[0]).toBeCloseTo(40 + mid + 15, 6);
    const volume = meshVolume(result.document, part);
    expect(Math.abs((flat.extents[0] * 30 * T) / volume - 1)).toBeLessThan(1e-2);
  });

  it('refuses profiles that cannot be formed, with stable codes', () => {
    const { doc, part } = plate(40, 30);
    expectRefusal(doc, 'add_contour_flange', params(part, { path: [[10, 0]] }), 'FTR_PARAM_INVALID', 'path');
    expectRefusal(
      doc,
      'add_contour_flange',
      params(part, {
        path: [
          [0, 10],
          [0, 20],
        ],
      }),
      'FTR_PARAM_INVALID',
      'path',
    );
    expectRefusal(doc, 'add_contour_flange', params(part, { path: [[0, 0]] }), 'FTR_PARAM_INVALID', 'path');
    expectRefusal(
      doc,
      'add_contour_flange',
      params(part, {
        path: [
          [0, 10],
          [0, 0],
        ],
      }),
      'FTR_BEND_ANGLE_OUT_OF_RANGE',
      'path',
    );
    expectRefusal(doc, 'add_contour_flange', params(part, { path: [[0, 6]] }), 'FTR_FLANGE_TOO_SHORT', 'path');
    expectRefusal(doc, 'add_contour_flange', params(part, { insideRadius: 0 }), 'FTR_SHARP_BEND_FORBIDDEN', 'insideRadius');
    expectRefusal(doc, 'add_contour_flange', params(part, { edge: { near: [20, 15, 40] } }), 'FTR_EDGE_NOT_STRAIGHT', 'edge.near');
    expectRefusal(doc, 'add_contour_flange', params('nope'), 'FTR_PART_NOT_FOUND', 'id');
    const strict = apply(doc, 'import_bend_radius_table', {
      rows: [{ material: '2024-T3', temper: 'T3', thickness: 1.6, minInsideRadius: 6, units: 'mm', bendAngle: 90, source: 'test' }],
    });
    expectRefusal(strict, 'add_contour_flange', params(part), 'FTR_BEND_RADIUS_BELOW_MIN', 'insideRadius');
  });

  it('is pure', () => {
    const { doc, part } = plate(40, 30);
    const before = JSON.stringify(doc);
    execute(
      doc,
      'add_contour_flange',
      params(part, {
        path: [
          [0, 20],
          [15, 20],
        ],
      }),
    );
    expect(JSON.stringify(doc)).toBe(before);
  });
});
