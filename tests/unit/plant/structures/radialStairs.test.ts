/**
 * Plant 06 STA-FU2c: winder and spiral stairs. No winder / spiral rule is cited in the pack's sources, so nothing is judged; the numbers are geometry.
 * Winder hand numbers: width 800 (default), rise 3000 / riserMax 180 -> 17 risers of h = 176.4706, going 280, 3 straight treads + 3 winders +
 * 10 treads (17 - 1 - 3 - 3). Winders of 30 degrees round the inner corner of the 800 mm square: wedge 1 = 1/2 x 800 x 800 tan 30 = 184 752 mm2,
 * wedge 3 the same, wedge 2 = 640 000 - 2 x 184 752 = 270 496 mm2. Tread area = 13 x 0.224 + 0.64 = 3.552 m2. Top of the stair for a left turn at
 * angle 0: x = 3 x 280 + 400 = 1240, y = 400 + 10 x 280 = 3200. Walkline at 300 mm: going = 300 x pi / 6 = 157.08 mm.
 * Spiral: CHS168.3x6.3 column (radius 84.15), outer radius 900, 22.5 degree treads (3 plan segments of 7.5 degrees): tread area =
 * 1/2 (900^2 - 84.15^2) x 3 x sin 7.5 deg per tread, 16 treads (360 degrees in all), column 17 x h = 3000 long.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { RadialStairElement } from '@aec/building/types';
import { radialStairErrors } from '@aec/plant/structures/radial/radialValidate';
import { winderWedge } from '@aec/plant/structures/radial/radialLayout';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';

const H = 3000 / 17;
const WINDER = { start: [0, 0, 0], rise: 3000, riserMax: 180, going: 280, straightTreads: 3, winders: 3, turn: 'left' };
const SPIRAL = {
  start: [5000, 0, 0],
  rise: 3000,
  riserMax: 180,
  outerRadius: 900,
  treadAngle: Math.PI / 8,
  turn: 'left',
  columnProfile: 'CHS168.3x6.3',
};

const scene = (): { doc: CadDocument; grade: string } => {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  return { doc, grade: Object.keys(doc.building?.levels ?? {})[0] as string };
};
const stairOf = (doc: CadDocument): RadialStairElement => {
  const element = doc.building?.elements['radialStair-1'];
  if (element?.category !== 'radialStair') throw new Error('no radial stair');
  return element;
};
const area = (corners: ReadonlyArray<readonly number[]>): number =>
  Math.abs(
    corners.reduce(
      (sum, [x, y], i) =>
        sum +
        (x as number) * (corners[(i + 1) % corners.length]?.[1] as number) -
        (corners[(i + 1) % corners.length]?.[0] as number) * (y as number),
      0,
    ),
  ) / 2;

describe('add_winder_stair', () => {
  const run = (params: Record<string, unknown> = {}): { doc: CadDocument; result: ReturnType<typeof ok> } => {
    const f = scene();
    const result = ok(f.doc, 'add_winder_stair', { ...WINDER, ...params, levelId: f.grade });
    return { doc: result.document, result };
  };

  it('splits the corner into three 30 degree wedges of the hand-calculated areas', () => {
    const wedges = [0, 1, 2].map((index) => area(winderWedge(index, 3, 800)));
    expect(wedges[0]).toBeCloseTo(184752, 0);
    expect(wedges[1]).toBeCloseTo(270496, 0);
    expect(wedges[2]).toBeCloseTo(184752, 0);
  });

  it('adds the stair: 16 treads at i x h, the hand-calculated area, top point and walkline going', () => {
    const { doc, result } = run({ walklineOffset: 300 });
    const stair = stairOf(doc);
    expect(result.affected).toEqual(['radialStair-1', 'radialStair-1:sections', 'radialStair-1:treads']);
    expect(doc.building?.elementOrder).toContain('radialStair-1');
    expect(stair.plates).toHaveLength(16);
    stair.plates.forEach((plate, index) => expect(plate.top).toBeCloseTo((index + 1) * H, 9));
    expect(stair.runs).toHaveLength(6);
    const info = result.data as Record<string, unknown> & { winders: Array<{ angleDeg: number; goingAtWalklineMm: number }> };
    expect(info['treadAreaM2']).toBeCloseTo(3.552, 4);
    expect(info['endPlanMm']).toEqual([1240, 3200]);
    expect(info['secondFlightTreads']).toBe(10);
    expect(info['rules']).toMatchObject({ evaluated: false });
    expect(info.winders).toHaveLength(3);
    expect(info.winders[0]?.angleDeg).toBe(30);
    expect(info.winders[0]?.goingAtWalklineMm).toBeCloseTo(157.08, 2);
    expect(result.summary).toContain('No winder / spiral going');
    expect(doc.order.length).toBeGreaterThan(0);
  });

  it('a right turn mirrors the plan; angle rotates it', () => {
    const right = (run({ turn: 'right' }).result.data as { endPlanMm: number[] }).endPlanMm;
    expect(right).toEqual([1240, -3200]);
    const rotated = (run({ angle: Math.PI / 2 }).result.data as { endPlanMm: number[] }).endPlanMm;
    expect(rotated[0]).toBeCloseTo(-3200, 3);
    expect(rotated[1]).toBeCloseTo(1240, 3);
  });

  it('feeds quantity_takeoff and export_ifc', () => {
    const { doc } = run();
    const lines = data<{ lines: Array<{ key: string; quantity: number }> }>(doc, 'quantity_takeoff', {}).lines;
    expect(lines.find((line) => line.key === 'radialStair.tread.ea')?.quantity).toBe(16);
    const ifc = data<{ ifc: string }>(doc, 'export_ifc', {}).ifc;
    expect(ifc).toContain('QUARTER_WINDING_STAIR');
    expect(ifc).toContain('.WINDER.');
  });

  it('refuses by name: no straight tread left, a walkline wider than the stair, a duplicate, an unknown profile', () => {
    const f = scene();
    const base = { ...WINDER, levelId: f.grade };
    expectRefusal(f.doc, 'add_winder_stair', { ...base, straightTreads: 14 }, 'STA_INVALID_GEOMETRY', 'straightTreads');
    expectRefusal(f.doc, 'add_winder_stair', { ...base, walklineOffset: 900 }, 'STA_INVALID_GEOMETRY', 'walklineOffset');
    expectRefusal(f.doc, 'add_winder_stair', { ...base, stringerProfile: 'NOPE' }, 'STA_INVALID_GEOMETRY', 'stringerProfile');
    expectRefusal(f.doc, 'add_winder_stair', { ...base, riserMax: 3000 }, 'STA_INVALID_GEOMETRY', 'riserMax');
    expectRefusal(f.doc, 'add_winder_stair', { ...base, rise: 40000 }, 'STA_INVALID_GEOMETRY', 'rise');
    const once = apply(f.doc, 'add_winder_stair', base);
    expectRefusal(once, 'add_winder_stair', base, 'STA_INVALID_GEOMETRY');
    expect(execute(f.doc, 'add_winder_stair', { ...base, winders: 1 }).rejected).toBe(true);
    expectRefusal(f.doc, 'add_winder_stair', { ...base, levelId: 'nope' }, 'STA_INVALID_GEOMETRY', 'levelId');
  });

  it('is pure', () => {
    const f = scene();
    expectPure(f.doc, () => execute(f.doc, 'add_winder_stair', { ...WINDER, levelId: f.grade }));
  });
});

describe('add_spiral_stair', () => {
  const run = (params: Record<string, unknown> = {}): { doc: CadDocument; result: ReturnType<typeof ok> } => {
    const f = scene();
    const result = ok(f.doc, 'add_spiral_stair', { ...SPIRAL, ...params, levelId: f.grade });
    return { doc: result.document, result };
  };

  it('adds a column and 16 sector treads of the hand-calculated area', () => {
    const { doc, result } = run();
    const stair = stairOf(doc);
    expect(result.affected).toEqual(['radialStair-1', 'radialStair-1:sections', 'radialStair-1:treads']);
    expect(stair.plates).toHaveLength(16);
    expect(stair.runs).toEqual([{ from: [5000, 0, 0], to: [5000, 0, 3000] }]);
    const perTread = 0.5 * (900 ** 2 - 84.15 ** 2) * 3 * Math.sin((7.5 * Math.PI) / 180);
    expect(area(stair.plates[0]?.corners ?? [])).toBeCloseTo(perTread, 3);
    const info = result.data as Record<string, number>;
    expect(info['treadAreaM2']).toBeCloseTo((16 * perTread) / 1e6, 4);
    expect(info['totalTurnDeg']).toBe(360);
    expect(info['risePerTurnMm']).toBeCloseTo(16 * H, 2);
    expect(info['columnRadiusMm']).toBeCloseTo(84.15, 9);
    expect(info['outerArcMm']).toBeCloseTo(900 * (Math.PI / 8), 3);
    stair.plates.forEach((plate, index) => expect(plate.top).toBeCloseTo((index + 1) * H, 9));
  });

  it('feeds quantity_takeoff and export_ifc', () => {
    const { doc } = run({ turn: 'right' });
    const lines = data<{ lines: Array<{ key: string; quantity: number }> }>(doc, 'quantity_takeoff', {}).lines;
    expect(lines.find((line) => line.key === 'radialStair.tread.ea')?.quantity).toBe(16);
    const ifc = data<{ ifc: string }>(doc, 'export_ifc', {}).ifc;
    expect(ifc).toContain('SPIRAL_STAIR');
    expect(ifc).toContain('.SPIRAL.');
  });

  it('refuses by name: a non-CHS or unknown column, an outer radius inside the column, too few risers, a duplicate', () => {
    const f = scene();
    const base = { ...SPIRAL, levelId: f.grade };
    expectRefusal(f.doc, 'add_spiral_stair', { ...base, columnProfile: 'IPE200' }, 'STA_INVALID_GEOMETRY', 'columnProfile');
    expectRefusal(f.doc, 'add_spiral_stair', { ...base, columnProfile: 'NOPE' }, 'STA_INVALID_GEOMETRY', 'columnProfile');
    expectRefusal(f.doc, 'add_spiral_stair', { ...base, outerRadius: 80 }, 'STA_INVALID_GEOMETRY', 'outerRadius');
    expectRefusal(f.doc, 'add_spiral_stair', { ...base, riserMax: 3000 }, 'STA_INVALID_GEOMETRY', 'riserMax');
    expectRefusal(f.doc, 'add_spiral_stair', { ...base, tread: { kind: 'grating', gratingType: 'nope' } }, 'STA_GRATING_TYPE_UNKNOWN');
    expect(execute(f.doc, 'add_spiral_stair', { ...base, treadAngle: 4 }).rejected).toBe(true);
    const once = apply(f.doc, 'add_spiral_stair', base);
    expectRefusal(once, 'add_spiral_stair', base, 'STA_INVALID_GEOMETRY');
  });

  it('is pure; check_access names the category it does not judge', () => {
    const { doc } = run();
    expectPure(doc, () => execute(doc, 'add_spiral_stair', { ...SPIRAL, start: [0, 0, 0] }));
    const result = execute(doc, 'check_access', { elementIds: ['radialStair-1'] });
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(doc);
  });
});

describe('radial stair element validation (document load)', () => {
  it('accepts a generated element and names every broken field of a corrupted one', () => {
    const f = scene();
    const stair = stairOf(apply(f.doc, 'add_winder_stair', { ...WINDER, levelId: f.grade }));
    expect(radialStairErrors('radialStair-1', JSON.parse(JSON.stringify(stair)))).toEqual([]);
    const errors = radialStairErrors('radialStair-1', {
      ...stair,
      form: 'x',
      turn: 'up',
      start: 1,
      profile: 'NOPE',
      tread: {},
      plates: [],
      runs: [1],
    });
    expect(errors).toHaveLength(7);
    expect(errors.join(' ')).toContain('plates must be treads');
  });
});
