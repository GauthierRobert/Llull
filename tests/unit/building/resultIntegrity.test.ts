import { describe, expect, it } from 'vitest';
import { portalHall } from '../../helpers/portalHall';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { BuildingElement } from '@aec/building/types';
import { anchorBoltResistance, boltResistance } from '@aec/industrial/steelDesign/steelBolts';
import { isSteelRefusal, steelStrength } from '@aec/industrial/steelDesign/steelGrades';
import { mapElements } from './elementEdits';
import { check, rowOf, squareBay } from './steelFixtures';

const BAD_GRADES = ['A36', '1.0570', 'Fe360', '', '235', 'S960'];

const hall = (params: Record<string, unknown> = {}): CadDocument =>
  portalHall({ span: 24000, length: 30000, ...params }, createEmptyDocument());

const withMaterial = (doc: CadDocument, material: string, only?: (element: BuildingElement) => boolean): CadDocument =>
  mapElements(doc, (element) =>
    (element.category === 'member' || element.category === 'plate') && (only?.(element) ?? true) ? { ...element, material } : element,
  );

interface Row {
  readonly utilisation: number;
  readonly check: string;
}

const rowsOf = (doc: CadDocument, tool: string, params: Record<string, unknown> = {}): Row[] =>
  (execute(doc, tool, params).data as { rows: Row[] }).rows;

describe('steelStrength (VC-INT-03, 04, 05, 27)', () => {
  it.each(BAD_GRADES)("refuses grade '%s' with STL_GRADE_UNKNOWN instead of using S355", (grade) => {
    const outcome = steelStrength(grade, 12);
    expect(isSteelRefusal(outcome)).toBe(true);
    expect(outcome).toMatchObject({ code: 'STL_GRADE_UNKNOWN' });
    expect((outcome as { message: string }).message).toContain('S355');
  });
  it('reads S235JR at 12 mm as 235 N/mm² and names the rule', () => {
    const outcome = steelStrength('S235JR', 12);
    expect(outcome).toMatchObject({ fy: 235, fu: 360, thicknessMm: 12 });
    expect((outcome as { rule: string }).rule).toContain('EN 1993-1-1 Tab. 3.1');
    expect((outcome as { rule: string }).rule).toContain('t ≤ 40 mm');
  });
  it('tolerates case, whitespace and quality suffixes', () => {
    expect(steelStrength(' s 355 j2 ', 20)).toMatchObject({ fy: 355 });
    expect(steelStrength('S355J2+N', 20)).toMatchObject({ fy: 355 });
    expect(steelStrength('S275', 20)).toMatchObject({ fy: 275, fu: 430 });
  });
  it('uses the 40 < t ≤ 80 band: S355J2 at 50 mm is 335 N/mm²', () => {
    expect(steelStrength('S355J2', 50)).toMatchObject({ fy: 335, fu: 470 });
    expect(steelStrength('S235', 50)).toMatchObject({ fy: 215 });
    expect(steelStrength('S355', 40)).toMatchObject({ fy: 355 });
    expect(steelStrength('S355', 40.01)).toMatchObject({ fy: 335 });
  });
  it('refuses thicker than 80 mm and non-positive thickness with STL_THICKNESS_OUT_OF_RANGE', () => {
    expect(steelStrength('S355J2', 90)).toMatchObject({ code: 'STL_THICKNESS_OUT_OF_RANGE' });
    expect(steelStrength('S355', 80)).toMatchObject({ fy: 335 });
    expect(steelStrength('S355', 0)).toMatchObject({ code: 'STL_THICKNESS_OUT_OF_RANGE' });
    expect(steelStrength('S355', Number.NaN)).toMatchObject({ code: 'STL_THICKNESS_OUT_OF_RANGE' });
  });
});

describe('bolt resistance (VC-INT-06, 07, 08)', () => {
  it('M20 class 10.9: Fv,Rd = 98,000 N and Ft,Rd = 176,400 N', () => {
    const resistance = boltResistance(20, '10.9') as { shear: number; tension: number };
    expect(resistance.shear).toBeCloseTo(98000, 6);
    expect(resistance.tension).toBeCloseTo(176400, 6);
  });
  it('M20 class 8.8 keeps 94,080 / 141,120 N and is the default', () => {
    expect(boltResistance(20)).toEqual(boltResistance(20, '8.8'));
    const resistance = boltResistance(20, '8.8') as { shear: number; tension: number };
    expect(resistance.shear).toBeCloseTo(94080, 6);
    expect(resistance.tension).toBeCloseTo(141120, 6);
  });
  it('M18 class 8.8: As 192 mm², Fv,Rd = 73,728 N (not M16 or M20)', () => {
    const resistance = boltResistance(18, '8.8') as { shear: number; tension: number };
    expect(resistance.shear).toBeCloseTo(73728, 6);
    expect(resistance.tension).toBeCloseTo((0.9 * 800 * 192) / 1.25, 6);
  });
  it('applies alpha_v 0.6 to 4.6 / 5.6 / 8.8 and 0.5 to 6.8 / 10.9', () => {
    const shear = (name: string): number => (boltResistance(16, name) as { shear: number }).shear;
    expect(shear('4.6')).toBeCloseTo((0.6 * 400 * 157) / 1.25, 6);
    expect(shear('5.6')).toBeCloseTo((0.6 * 500 * 157) / 1.25, 6);
    expect(shear('6.8')).toBeCloseTo((0.5 * 600 * 157) / 1.25, 6);
  });
  it('refuses M19 with its neighbours and class 12.9, and any size outside M12..M36', () => {
    const size = boltResistance(19, '8.8');
    expect(size).toMatchObject({ code: 'STL_BOLT_SIZE_NONSTANDARD' });
    expect((size as { message: string }).message).toContain('M18, M20');
    expect(boltResistance(20, '12.9')).toMatchObject({ code: 'STL_BOLT_CLASS_UNKNOWN' });
    expect(boltResistance(20, 'constructor')).toMatchObject({ code: 'STL_BOLT_CLASS_UNKNOWN' });
    expect((boltResistance(10, '8.8') as { message: string }).message).toContain('neighbours: M12');
    expect((boltResistance(40, '8.8') as { message: string }).message).toContain('neighbours: M36');
  });
  it('refuses a nonstandard anchor size or class too, and honours the anchor class', () => {
    expect(anchorBoltResistance(25)).toMatchObject({ code: 'STL_BOLT_SIZE_NONSTANDARD' });
    expect(anchorBoltResistance(24, '12.9')).toMatchObject({ code: 'STL_BOLT_CLASS_UNKNOWN' });
    expect((anchorBoltResistance(24, '6.8') as { tension: number }).tension).toBeCloseTo((0.9 * 600 * 353) / 1.25, 6);
  });
});

describe('check_steel_members refuses a bad grade (VC-INT-03)', () => {
  it.each(BAD_GRADES)("marks every member with grade '%s' not analysed, never ok", (grade) => {
    const data = check(withMaterial(squareBay(), grade));
    expect(data.ok).toBe(false);
    for (const member of data.members) {
      expect(member.analysed).toBe(false);
      expect(member.detail).toContain('STL_GRADE_UNKNOWN');
    }
  });
  it('checks a valid grade as before', () => {
    const data = check(squareBay());
    expect(data.members.some((member) => member.analysed)).toBe(true);
    expect(rowOf(data, data.members[0]?.mark ?? '').detail).not.toContain('STL_');
  });
});

describe('hall checks refuse a bad grade (VC-INT-03)', () => {
  it.each(['A36', '1.0570'])("check_bracing fails every row of grade '%s'", (grade) => {
    const rows = rowsOf(withMaterial(hall(), grade), 'check_bracing');
    expect(rows.length).toBeGreaterThan(0);
    const refused = rows.filter((row) => row.check.includes('STL_GRADE_UNKNOWN'));
    expect(refused.length).toBeGreaterThan(0);
    for (const row of refused) expect(row.utilisation).toBeGreaterThan(1);
    expect(execute(withMaterial(hall(), grade), 'check_bracing', {}).summary).not.toMatch(/all OK/);
  });
  it('check_purlins fails every purlin and rail row', () => {
    const rows = rowsOf(withMaterial(hall(), 'Fe360'), 'check_purlins');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.check).toContain('STL_GRADE_UNKNOWN');
      expect(row.utilisation).toBeGreaterThan(1);
    }
  });
  it('check_portal_frames fails the column and rafter rows', () => {
    const rows = rowsOf(withMaterial(hall(), 'A36'), 'check_portal_frames');
    const members = rows.filter((row) => row.check.includes('STL_GRADE_UNKNOWN'));
    expect(members.length).toBeGreaterThanOrEqual(2);
    for (const row of members) expect(row.utilisation).toBeGreaterThan(1);
  });
  it('check_portal_frames names the strength rule in member rows', () => {
    const rows = rowsOf(hall(), 'check_portal_frames');
    expect(rows.some((row) => row.check.includes('EN 1993-1-1 Tab. 3.1') && row.check.includes('fy 355'))).toBe(true);
  });
  it('check_crane_runways fails the beam rows', () => {
    const doc = withMaterial(portalHall({ span: 24000, length: 30000, crane: { capacity: 10, railHeight: 6000 } }), 'A36');
    const rows = rowsOf(doc, 'check_crane_runways');
    expect(rows.some((row) => row.check.includes('STL_GRADE_UNKNOWN') && row.utilisation > 1)).toBe(true);
  });
  it('check_foundations fails a fixed base plate of unknown grade, and a plate over 80 mm', () => {
    const fixed = hall({ columnBase: 'fixed' });
    const bad = rowsOf(
      withMaterial(fixed, 'A36', (element) => element.category === 'plate'),
      'check_foundations',
    );
    expect(bad.some((row) => row.check.includes('STL_GRADE_UNKNOWN') && row.utilisation > 1)).toBe(true);
    const thick = mapElements(fixed, (element) => (element.category === 'plate' ? { ...element, thickness: 90 } : element));
    expect(rowsOf(thick, 'check_foundations').some((row) => row.check.includes('STL_THICKNESS_OUT_OF_RANGE'))).toBe(true);
  });
  it('design_portal_frames does not resize fixed base plates of unknown grade', () => {
    const fixed = withMaterial(hall({ columnBase: 'fixed' }), 'A36', (element) => element.category === 'plate');
    const result = execute(fixed, 'design_portal_frames', { windPressure: 0.7 });
    expect(result.summary).toContain('STL_GRADE_UNKNOWN');
  });
});

describe('bolt class parameter (VC-INT-08, 09)', () => {
  const anchorCheck = (doc: CadDocument, params: Record<string, unknown> = {}): ReturnType<typeof execute> =>
    execute(doc, 'check_foundations', params);
  const defaultedOf = (result: ReturnType<typeof execute>): unknown => (result.data as { defaulted: unknown }).defaulted;

  it('check_portal_frames records the defaulted class in data and summary', () => {
    const result = execute(hall(), 'check_portal_frames', {});
    expect(defaultedOf(result)).toEqual([{ input: 'boltClass', value: '8.8' }]);
    expect(result.summary).toContain('bolts class 8.8 (defaulted)');
  });
  it('an explicit class is not reported as defaulted and changes the bolt resistance', () => {
    const base = execute(hall(), 'check_portal_frames', {});
    const strong = execute(hall(), 'check_portal_frames', { boltClass: '10.9' });
    expect(defaultedOf(strong)).toEqual([]);
    expect(strong.summary).toContain('bolts class 10.9');
    expect(strong.summary).not.toContain('(defaulted)');
    const connection = (result: ReturnType<typeof execute>): number =>
      Math.max(
        ...(result.data as { rows: Array<Row & { kind: string }> }).rows
          .filter((row) => row.kind === 'connection')
          .map((row) => row.utilisation),
      );
    expect(connection(strong)).toBeLessThan(connection(base));
    const weak = execute(hall(), 'check_portal_frames', { boltClass: '4.6' });
    expect(connection(weak)).toBeGreaterThan(connection(base));
  });
  it('refuses an unknown class with STL_BOLT_CLASS_UNKNOWN and changes nothing', () => {
    const doc = hall();
    for (const tool of ['check_portal_frames', 'design_portal_frames', 'check_foundations']) {
      const result = execute(doc, tool, { boltClass: '12.9' });
      expect(result.summary).toContain('STL_BOLT_CLASS_UNKNOWN');
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
  });
  it('check_foundations and design_portal_frames report the defaulted class', () => {
    const foundation = anchorCheck(hall());
    expect(defaultedOf(foundation)).toEqual([{ input: 'boltClass', value: '8.8' }]);
    expect(foundation.summary).toContain('bolts class 8.8 (defaulted)');
    expect(defaultedOf(anchorCheck(hall(), { boltClass: '5.6' }))).toEqual([]);
    const design = execute(hall(), 'design_portal_frames', { windPressure: 0.7 });
    expect(defaultedOf(design)).toEqual([{ input: 'boltClass', value: '8.8' }]);
    expect(design.summary).toContain('(defaulted)');
  });
  it('anchor rows follow the class: 4.6 anchors are weaker than 10.9', () => {
    const tension = (boltClass: string): number =>
      Math.max(
        ...rowsOf(hall({ columnBase: 'fixed' }), 'check_foundations', { windPressure: 0.7, boltClass })
          .filter((row) => row.check.startsWith('anchor shear'))
          .map((row) => row.utilisation),
      );
    expect(tension('4.6')).toBeGreaterThan(tension('10.9'));
  });
  it('fails the plate row of a non-standard anchor diameter with STL_BOLT_SIZE_NONSTANDARD', () => {
    const odd = mapElements(hall(), (element) => (element.category === 'plate' ? { ...element, boltDiameter: 25 } : element));
    const rows = rowsOf(odd, 'check_foundations');
    const refused = rows.filter((row) => row.check.includes('STL_BOLT_SIZE_NONSTANDARD'));
    expect(refused.length).toBeGreaterThan(0);
    for (const row of refused) expect(row.utilisation).toBeGreaterThan(1);
  });
  it('fails the connection row of a non-standard end-plate bolt diameter', () => {
    const odd = mapElements(hall(), (element) => (element.category === 'connection' ? { ...element, boltDiameter: 19 } : element));
    const rows = rowsOf(odd, 'check_portal_frames');
    expect(rows.some((row) => row.check.includes('STL_BOLT_SIZE_NONSTANDARD') && row.utilisation > 1)).toBe(true);
  });
});
