import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import expected from '../../../../docs/aerospace/07-sheet-metal-machined-features/validation/data/expected_flat_pattern.json';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface CalcData {
  mode: string;
  ba: number;
  ossb: number;
  issb: number;
  bd: number;
  kChart: number;
  rOverT: number;
  kFactor?: { value: number; standard: string; defaulted: boolean };
  minRadius?: { value: number; verification: string; rowId: string; source: string };
  lengthUnit: string;
  angleUnit: string;
  unverified: boolean;
  unverifiedInputs: Array<{ kind: string; id: string }>;
  reviewRequired: boolean;
  provenance: {
    formulas: Record<string, string>;
    inputs: Record<string, { value: number | string; unit?: string; defaulted?: boolean }>;
    sources: string[];
  };
}

const doc = createEmptyDocument();

describe('sheet_metal_calc (VC-FTR-01, VC-FTR-02, VC-FTR-04, VC-FTR-05, VC-FTR-35)', () => {
  it.each(expected.bends)('$id matches the reference to 1e-6 mm / 1e-7 in', (row) => {
    const result = data<CalcData>(doc, 'sheet_metal_calc', {
      units: row.units,
      thickness: row.T,
      insideRadius: row.R,
      angle: row.theta_deg,
      kFactor: row.K_ansi,
      mode: 'k_factor',
    });
    const tolerance = row.units === 'mm' ? 1e-6 : 1e-7;
    expect(result.lengthUnit).toBe(row.units);
    expect(result.angleUnit).toBe('deg');
    expect(Math.abs(result.ba - row.BA)).toBeLessThan(tolerance);
    expect(Math.abs(result.ossb - row.OSSB)).toBeLessThan(tolerance);
    expect(Math.abs(result.issb - row.ISSB)).toBeLessThan(tolerance);
    expect(Math.abs(result.bd - row.BD)).toBeLessThan(tolerance);
    expect(Math.abs(result.kChart - row.K_chart_tan_half)).toBeLessThan(1e-9);
  });

  it.each(expected.bends.filter((row) => ['FP-08', 'FP-09', 'FP-10', 'FP-11'].includes(row.id)))(
    '$id: the inch values hold in an inch document and the mm document gives them x 25.4 to 1e-9 relative (VC-FTR-35)',
    (row) => {
      const inchDocument = apply(createEmptyDocument(), 'set_units', { units: 'in' });
      const call = (units: 'in' | 'mm', scale: number): CalcData =>
        data<CalcData>(inchDocument, 'sheet_metal_calc', {
          units,
          thickness: row.T * scale,
          insideRadius: row.R * scale,
          angle: row.theta_deg,
          kFactor: row.K_ansi,
          mode: 'k_factor',
        });
      const inch = call('in', 1);
      const mm = call('mm', 25.4);
      expect([inch.lengthUnit, mm.lengthUnit]).toEqual(['in', 'mm']);
      expect(Math.abs(inch.ba - row.BA)).toBeLessThan(1e-7);
      expect(Math.abs(inch.ossb - row.OSSB)).toBeLessThan(1e-7);
      for (const key of ['ba', 'ossb', 'issb', 'bd'] as const) expect(Math.abs(mm[key] / (inch[key] * 25.4) - 1)).toBeLessThan(1e-9);
    },
  );

  it('reproduces the AC 43.13-1B setbacks 0.130 / 0.758 in and K-chart values (VC-FTR-02)', () => {
    const at = (angle: number): CalcData =>
      data<CalcData>(doc, 'sheet_metal_calc', { units: 'in', thickness: 0.064, insideRadius: 0.25, angle, kFactor: 0.4475 });
    expect(Math.abs(at(45).ossb - 0.13)).toBeLessThan(0.0005);
    expect(Math.abs(at(135).ossb - 0.758)).toBeLessThan(0.0005);
    expect(at(45).kChart).toBeCloseTo(0.41421, 5);
    expect(at(135).kChart).toBeCloseTo(2.4142, 4);
  });

  it('uses the FAA empirical formula without a K-factor (VC-FTR-03)', () => {
    const result = data<CalcData>(doc, 'sheet_metal_calc', {
      units: 'in',
      thickness: 0.04,
      insideRadius: 0.25,
      angle: 60,
      mode: 'faa_empirical',
    });
    expect(result.mode).toBe('faa_empirical');
    expect(result.ba).toBeCloseTo(0.28017, 7);
    expect(Math.abs(result.ba - 0.2796)).toBeLessThan(0.0007);
    expect(result.kFactor).toBeUndefined();
    expect(result.provenance.formulas['ba']).toBe('(0.01743*R+0.0078*T)*theta_deg');
  });

  it('converts a DIN K-factor to ANSI (VC-FTR-05)', () => {
    const result = data<CalcData>(doc, 'sheet_metal_calc', {
      units: 'mm',
      thickness: 1.6,
      insideRadius: 4.8,
      angle: 90,
      kFactor: 0.88,
      kStandard: 'din',
    });
    expect(result.kFactor).toMatchObject({ value: 0.44, standard: 'ansi', defaulted: false });
    expect(result.ba).toBeCloseTo(8.645662983, 6);
    expect(result.provenance.formulas['kFactor']).toBe('K_ansi=K_din/2');
  });

  it('explains every value: formulas, inputs with units, sources (VC-FTR-43)', () => {
    const result = data<CalcData>(doc, 'sheet_metal_calc', {
      units: 'in',
      thickness: 0.064,
      insideRadius: 0.25,
      angle: 135,
      kFactor: 0.4475,
    });
    expect(result.provenance.formulas['ossb']).toBe('tan(theta/2)*(R+T)');
    expect(result.provenance.formulas['ba']).toBe('theta*(R+K*T)');
    expect(result.provenance.inputs['thickness']).toMatchObject({ value: 0.064, unit: 'in' });
    expect(result.provenance.inputs['kStandard']).toMatchObject({ value: 'ansi', defaulted: true });
    expect(result.provenance.sources).toContain('R2');
    expect(result.reviewRequired).toBe(true);
  });

  it('says the result is not approved in the summary', () => {
    expect(ok(doc, 'sheet_metal_calc', { units: 'mm', thickness: 1, insideRadius: 1, angle: 90, kFactor: 0.4 }).summary).toContain(
      'not approved',
    );
  });

  it('never changes the document and needs no part', () => {
    const result = ok(doc, 'sheet_metal_calc', { units: 'mm', thickness: 1, insideRadius: 1, angle: 90, kFactor: 0.4 });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});

describe('sheet_metal_calc refusals (VC-FTR-37, 39)', () => {
  const base = { units: 'mm', thickness: 1.6, insideRadius: 4.8, angle: 90 };
  it('refuses a missing K-factor in k_factor mode and never defaults it', () => {
    expectRefusal(doc, 'sheet_metal_calc', base, 'FTR_K_FACTOR_MISSING', 'kFactor');
    expectRefusal(doc, 'sheet_metal_calc', { ...base, mode: 'k_factor' }, 'FTR_K_FACTOR_MISSING', 'kFactor');
  });
  it('refuses a K-factor outside its standard range', () => {
    expectRefusal(doc, 'sheet_metal_calc', { ...base, kFactor: 0.6 }, 'FTR_K_FACTOR_OUT_OF_RANGE', 'kFactor');
    expectRefusal(doc, 'sheet_metal_calc', { ...base, kFactor: 0 }, 'FTR_K_FACTOR_OUT_OF_RANGE', 'kFactor');
    expectRefusal(doc, 'sheet_metal_calc', { ...base, kFactor: 1.2, kStandard: 'din' }, 'FTR_K_FACTOR_OUT_OF_RANGE', 'kFactor');
    expect(ok(doc, 'sheet_metal_calc', { ...base, kFactor: 0.9, kStandard: 'din' }).rejected).toBeUndefined();
  });
  it('refuses angles outside (0, 180)', () => {
    for (const angle of [0, -5, 180, 200])
      expectRefusal(doc, 'sheet_metal_calc', { ...base, angle, kFactor: 0.44 }, 'FTR_BEND_ANGLE_OUT_OF_RANGE', 'angle');
  });
  it('refuses non-positive thickness and negative radius', () => {
    expectRefusal(doc, 'sheet_metal_calc', { ...base, thickness: 0, kFactor: 0.44 }, 'FTR_PARAM_INVALID', 'thickness');
    expectRefusal(doc, 'sheet_metal_calc', { ...base, insideRadius: -1, kFactor: 0.44 }, 'FTR_PARAM_INVALID', 'insideRadius');
  });
  it('rejects a bad type or missing unit through the schema', () => {
    const wrong = execute(doc, 'sheet_metal_calc', { ...base, thickness: 'abc', kFactor: 0.4 });
    expect(wrong.rejected).toBe(true);
    expect(wrong.error?.code).toBe('CMD_INVALID_PARAMS');
    expect(wrong.summary).toContain('thickness');
    expect(execute(doc, 'sheet_metal_calc', { thickness: 1, insideRadius: 1, angle: 90, kFactor: 0.4 }).rejected).toBe(true);
  });
});

describe('minimum radius and unverified propagation (VC-FTR-40)', () => {
  const row = {
    material: 'TEST-ALLOY',
    temper: 'T0',
    thickness: 0.8,
    minInsideRadius: 2.0,
    units: 'mm',
    bendAngle: 90,
    source: 'synthetic test row (not engineering data)',
    verification: 'unverified',
  };
  const query = { units: 'mm', thickness: 0.8, insideRadius: 2.4, angle: 90, kFactor: 0.4, material: 'TEST-ALLOY', temper: 'T0' };

  it('returns the matching row as a named minRadius and flags the result unverified', () => {
    const table = apply(doc, 'import_bend_radius_table', { rows: [row] });
    const result = data<CalcData>(table, 'sheet_metal_calc', query);
    expect(result.minRadius).toMatchObject({ value: 2, verification: 'unverified', source: row.source });
    expect(result.minRadius?.rowId).toBe('TEST-ALLOY/T0/0.8mm/90deg');
    expect(result.unverified).toBe(true);
    expect(result.unverifiedInputs.map((input) => input.kind)).toContain('radius_row');
  });
  it('converts a row in inches to the requested unit and stays verified when the row is', () => {
    const table = apply(doc, 'import_bend_radius_table', {
      rows: [{ ...row, thickness: 0.8 / 25.4, minInsideRadius: 2 / 25.4, units: 'in', verification: 'verified' }],
    });
    const result = data<CalcData>(table, 'sheet_metal_calc', query);
    expect(result.minRadius?.value).toBeCloseTo(2, 9);
    expect(result.unverified).toBe(false);
  });
  it('has no minRadius without a table, a temper, or a matching thickness', () => {
    const table = apply(doc, 'import_bend_radius_table', { rows: [row] });
    expect(data<CalcData>(doc, 'sheet_metal_calc', query).minRadius).toBeUndefined();
    expect(data<CalcData>(table, 'sheet_metal_calc', { ...query, temper: undefined }).minRadius).toBeUndefined();
    expect(data<CalcData>(table, 'sheet_metal_calc', { ...query, thickness: 1.0 }).minRadius).toBeUndefined();
    expect(ok(table, 'sheet_metal_calc', { ...query, thickness: 1.0 }).summary).toContain('No radius-table row');
  });
});
