/**
 * VC-EQP-08: API 650 one-foot method of `tank_shell_thickness` against the validation pack
 * (docs/plant/03-parametric-equipment/validation/data/api650_references.json) and SC-EQP-04 rows.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { mmDocument } from './equipmentFixtures';

const REFERENCES = path.resolve(__dirname, '../../../../docs/plant/03-parametric-equipment/validation/data');
const reference = JSON.parse(readFileSync(path.join(REFERENCES, 'api650_references.json'), 'utf8')) as {
  workedExample: { inputs: Record<string, number>; derived: Record<string, number> };
  allowableStressRows: Array<{ material: string; Sd_MPa: number; St_MPa: number }>;
};

interface Course {
  course: number;
  H_m: number;
  designThicknessMm: number;
  testThicknessMm: number;
  governingThicknessMm: number;
  governing: string;
  minimumThickness: { mm: number; source: string; unverified: boolean };
}
interface Tank {
  courses: Course[];
  allowableStress: { Sd: { value: number; source: string | null }; St: { value: number; source: string | null } };
  unverified: boolean;
  warnings: Array<{ code: string; paths: string[] }>;
  reviewRequired: boolean;
  reviewReason: string;
}

const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

/** SC-EQP-04: T-401, D 20 m, six 2 m courses, G 1.0, A36M, CA 1.5 mm, in mm. */
const fireWaterTank = {
  diameter: 20000,
  shellHeight: 12000,
  courses: [2000, 2000, 2000, 2000, 2000, 2000],
  designLiquidLevel: 12000,
  specificGravity: 1,
  material: 'A36M',
  corrosionAllowance: 1.5,
};
const tank = (params: object = {}): Tank => data<Tank>(mmDocument(), 'tank_shell_thickness', { ...fireWaterTank, ...params });

describe('VC-EQP-08: one-foot method, PPNS worked example (API650-PPNS)', () => {
  const { inputs, derived } = reference.workedExample;
  const metres = apply(createEmptyDocument(), 'set_units', { units: 'm' });
  const result = data<Tank>(metres, 'tank_shell_thickness', {
    method: 'one_foot',
    diameter: inputs.D_m,
    shellHeight: inputs.H_m,
    courses: [inputs.H_m],
    designLiquidLevel: inputs.H_m,
    specificGravity: inputs.G,
    material: 'A283M Gr C',
    corrosionAllowance: (inputs.CA_mm as number) / 1000,
  });

  it('t_d = 5.440 mm and t_t = 2.4255 mm to 1e-9 (published 5.44 / 2.43)', () => {
    const course = result.courses[0] as Course;
    expect(rel(course.designThicknessMm, derived.td_mm as number)).toBeLessThan(1e-9);
    expect(rel(course.testThicknessMm, derived.tt_mm as number)).toBeLessThan(1e-9);
    expect(Math.abs(course.designThicknessMm - 5.44)).toBeLessThan(5e-3);
    expect(Math.abs(course.testThicknessMm - 2.43)).toBeLessThan(5e-3);
  });

  it('Sd / St come from the A283M Gr C row (137 / 154 MPa) that the example uses', () => {
    expect(result.allowableStress.Sd.value).toBe(inputs.Sd_MPa);
    expect(result.allowableStress.St.value).toBe(inputs.St_MPa);
  });

  it('the governing thickness is the design thickness above the 5 mm minimum for D < 15 m (grade B row, unverified)', () => {
    const course = result.courses[0] as Course;
    expect(course.governing).toBe('design');
    expect(course.governingThicknessMm).toBe(course.designThicknessMm);
    expect(course.minimumThickness).toMatchObject({ mm: 5, unverified: true });
  });
});

describe('VC-EQP-08: Table 5-2a allowable stresses', () => {
  it.each([
    ['A36M', 'A36M'],
    ['A283M Gr C', 'A283M Gr C'],
    ['A283C', 'A283M Gr C'],
    ['A516-70', 'A516M Gr 485 (A516 Gr 70)'],
    ['A516M Gr 485', 'A516M Gr 485 (A516 Gr 70)'],
  ])('%s resolves to its published Sd / St row', (name, row) => {
    const expected = reference.allowableStressRows.find((candidate) => candidate.material === row) as { Sd_MPa: number; St_MPa: number };
    const result = tank({ material: name });
    expect([result.allowableStress.Sd.value, result.allowableStress.St.value]).toEqual([expected.Sd_MPa, expected.St_MPa]);
    expect(result.allowableStress.Sd.source).toContain('API 650 Table 5-2a');
  });
});

describe('SC-EQP-04: fire-water tank T-401 (rows of the validation plan)', () => {
  const result = tank();

  it('course 1: t_d = 4.9 x 20 x 11.7 x 1.0 / 160 + 1.5 = 8.66625 mm, t_t = 6.7052632 mm, H = 12 - 0.3 below the top', () => {
    const course = result.courses[0] as Course;
    expect(rel(course.designThicknessMm, 8.66625)).toBeLessThan(1e-9);
    expect(rel(course.testThicknessMm, 6.705263157894736)).toBeLessThan(1e-9);
    expect(course.H_m).toBe(12);
  });

  it('course 3 (H = 8 m) governs at 6.21625 mm; course 4 falls to the 6 mm minimum, reported unverified', () => {
    expect(rel((result.courses[2] as Course).governingThicknessMm, 6.21625)).toBeLessThan(1e-9);
    const fourth = result.courses[3] as Course;
    expect(fourth.governingThicknessMm).toBe(6);
    expect(fourth.governing).toBe('minimum');
    expect(fourth.minimumThickness).toMatchObject({ mm: 6, unverified: true });
  });

  it('the stress source is the grade-A table row; the minimum-thickness grade B row raises EQP_TABLE_UNVERIFIED; review is required', () => {
    expect(result.allowableStress.Sd.source).toBe('API 650 Table 5-2a A36M (data/api650_references.json, grade A)');
    expect(result.unverified).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['EQP_TABLE_UNVERIFIED']);
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReason).toContain('API 650');
  });

  it('thicker for denser product; courses above the liquid level fall to the minimum; D of 36..60 m uses the grade C row', () => {
    const heavy = tank({ specificGravity: 1.2 });
    expect((heavy.courses[0] as Course).designThicknessMm).toBeGreaterThan((result.courses[0] as Course).designThicknessMm);
    const half = tank({ designLiquidLevel: 5000 });
    expect((half.courses[5] as Course).H_m).toBe(-5);
    expect((half.courses[5] as Course).designThicknessMm).toBe(1.5);
    expect((half.courses[5] as Course).governingThicknessMm).toBe(6);
    const wide = tank({ diameter: 45000 });
    expect((wide.courses[5] as Course).minimumThickness).toMatchObject({ mm: 8, unverified: true });
  });
});

describe('tank_shell_thickness: refusals and provenance', () => {
  const doc = mmDocument();

  it('D > 60 m -> EQP_API650_ONE_FOOT_LIMIT (path diameter); D = 60 m is accepted', () => {
    expectRefusal(doc, 'tank_shell_thickness', { ...fireWaterTank, diameter: 65000 }, 'EQP_API650_ONE_FOOT_LIMIT', 'diameter');
    expect(execute(doc, 'tank_shell_thickness', { ...fireWaterTank, diameter: 60000 }).rejected).toBeUndefined();
  });

  it('edges: D = 60 m takes the grade C 8 mm row; a liquid level below the first course clamps H - 0.3 at 0 (design = CA, minimum governs)', () => {
    const wide = tank({ diameter: 60000 });
    expect(rel((wide.courses[0] as Course).designThicknessMm, (4.9 * 60 * 11.7) / 160 + 1.5)).toBeLessThan(1e-12);
    expect((wide.courses[5] as Course).minimumThickness).toMatchObject({ mm: 8, unverified: true });
    const low = tank({ designLiquidLevel: 200 });
    expect((low.courses[0] as Course).H_m).toBe(200 / 1000);
    expect((low.courses[0] as Course).designThicknessMm).toBe(1.5);
    expect((low.courses[0] as Course).testThicknessMm).toBe(0);
    expect((low.courses[0] as Course).governingThicknessMm).toBe(6);
  });

  it('a material outside the table needs Sd / St: EQP_MATERIAL_NOT_IN_TABLE, then accepted with a source (unverified without)', () => {
    expectRefusal(doc, 'tank_shell_thickness', { ...fireWaterTank, material: 'S355J2' }, 'EQP_MATERIAL_NOT_IN_TABLE', 'material');
    const sourced = data<Tank>(doc, 'tank_shell_thickness', {
      ...fireWaterTank,
      material: 'S355J2',
      allowableStress: { design: 200, test: 220, source: 'EN 14015 table' },
    });
    expect(sourced.allowableStress.Sd).toEqual({ value: 200, source: 'EN 14015 table' });
    expect(sourced.warnings.some((warning) => warning.code === 'EQP_VALUE_UNSOURCED')).toBe(false);
    const unsourced = data<Tank>(doc, 'tank_shell_thickness', {
      ...fireWaterTank,
      material: 'S355J2',
      allowableStress: { design: 200, test: 220 },
    });
    expect(unsourced.warnings.map((warning) => warning.code)).toContain('EQP_VALUE_UNSOURCED');
    expect(unsourced.allowableStress.Sd.source).toBeNull();
  });

  it('courses that do not add up -> EQP_COURSES_MISMATCH; a level above the shell -> EQP_PARAM_INVALID', () => {
    expectRefusal(doc, 'tank_shell_thickness', { ...fireWaterTank, courses: [2000, 2000] }, 'EQP_COURSES_MISMATCH', 'courses');
    expectRefusal(doc, 'tank_shell_thickness', { ...fireWaterTank, designLiquidLevel: 13000 }, 'EQP_PARAM_INVALID', 'designLiquidLevel');
  });

  it('is read-only and deterministic; a bad schema value is rejected by validation before the maths', () => {
    const result = execute(doc, 'tank_shell_thickness', fireWaterTank);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(execute(doc, 'tank_shell_thickness', fireWaterTank).data)).toBe(JSON.stringify(result.data));
    expect(execute(doc, 'tank_shell_thickness', { ...fireWaterTank, diameter: -1 }).rejected).toBe(true);
    expect(execute(doc, 'tank_shell_thickness', { ...fireWaterTank, method: 'variable_point' }).rejected).toBe(true);
  });
});
