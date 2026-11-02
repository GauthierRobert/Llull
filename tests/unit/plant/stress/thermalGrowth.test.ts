/**
 * Plant 07 PST M1: thermal_growth. VC-PST-04: carbon steel 70 -> 400 degF grows 2.70 in/100 ft, 30 m -> 67.52 mm (+-0.05 mm, grade A);
 * the other table rows are grade B and reproduce thermal_expansion_carbon_steel.json to 0.01 in/100 ft. Hand check:
 * 6.82e-6 x (400 - 70) = 2.2506e-3; x 30 000 mm = 67.518 mm. Midpoint 250 degF: strain (8.294e-4 + 1.518e-3) / 2 = 1.1737e-3 (linear in strain).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { cteModel, strainModel, withModel } from '../../physics/thermomech/thermomechFixtures';
import { MM_PER_IN, referenceData } from './stressFixtures';

interface Growth {
  growthMm: number;
  mmPerM: number;
  meanCtePerK: number | null;
  grade: string;
  source: string;
  reviewRequired: boolean;
  warnings: Array<{ code: string }>;
}

const doc = createEmptyDocument();
const growth = (params: Record<string, unknown>): Growth => data<Growth>(doc, 'thermal_growth', params);
const celsius = (fahrenheit: number): number => ((fahrenheit - 32) * 5) / 9;
const TABLE = { table: 'carbon-steel-c1' };

describe('VC-PST-04 carbon steel table (grade A at 400 degF)', () => {
  it('30 m from 70 to 400 degF grows 67.52 mm = 2.2506 mm/m', () => {
    const result = growth({ ...TABLE, fromC: celsius(70), toC: celsius(400), lengthM: 30 });
    expect(Math.abs(result.growthMm - 67.52)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(result.mmPerM - 2.2506)).toBeLessThanOrEqual(0.0005);
    expect(result.grade).toBe('A');
    expect(result.reviewRequired).toBe(true);
    expect(result.source).toContain('S8');
  });

  it('the SI spelling 21.1 -> 204.4 degC snaps to the rows (listed in the warnings) and still meets 0.05 mm', () => {
    const result = growth({ ...TABLE, fromC: 21.1, toC: 204.4, lengthM: 30 });
    expect(Math.abs(result.growthMm - 67.52)).toBeLessThanOrEqual(0.05);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['PST_TABLE_EDGE_SNAPPED']);
  });

  it('reproduces every table row in inches per 100 ft to 0.01, grade B except 400 degF', () => {
    const { rows } = referenceData<{ rows: Array<[number, number, number, string, string]> }>('thermal_expansion_carbon_steel.json');
    expect(rows).toHaveLength(8);
    for (const [fahrenheit, , inPer100ft, , grade] of rows) {
      const result = growth({ ...TABLE, fromC: celsius(70), toC: celsius(fahrenheit), lengthM: 30.48 });
      expect(Math.abs(result.growthMm / MM_PER_IN - inPer100ft), `${fahrenheit} degF`).toBeLessThanOrEqual(0.01);
      expect(result.grade).toBe(grade);
    }
  });

  it('interpolates the strain linearly between rows and from the 70 degF reference', () => {
    expect(Math.abs(growth({ ...TABLE, fromC: celsius(70), toC: celsius(250), lengthM: 1 }).growthMm - 1.1737)).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(growth({ ...TABLE, fromC: celsius(70), toC: celsius(135), lengthM: 1 }).growthMm - 0.4147)).toBeLessThanOrEqual(1e-4);
    expect(growth({ ...TABLE, fromC: celsius(70), toC: celsius(135), lengthM: 1 }).grade).toBe('B');
  });

  it('cooling shrinks; no temperature change gives zero growth and no mean coefficient', () => {
    expect(growth({ ...TABLE, fromC: celsius(400), toC: celsius(70), lengthM: 30 }).growthMm).toBeLessThan(-67);
    const flat = growth({ ...TABLE, fromC: 100, toC: 100, lengthM: 30 });
    expect([flat.growthMm, flat.meanCtePerK]).toEqual([0, null]);
  });

  it('refuses temperatures outside 21.1 to 482 degC and names the end (no extrapolation)', () => {
    expectRefusal(doc, 'thermal_growth', { ...TABLE, fromC: 21.111, toC: 500, lengthM: 30 }, 'PST_TEMPERATURE_OUT_OF_TABLE', 'toC');
    expectRefusal(doc, 'thermal_growth', { ...TABLE, fromC: 10, toC: 100, lengthM: 30 }, 'PST_TEMPERATURE_OUT_OF_TABLE', 'fromC');
  });
});

describe('other strain sources', () => {
  it('meanCtePerK: 1.2e-5 x 100 K x 10 m = 12 mm, flagged as not a sourced record', () => {
    const result = growth({ meanCtePerK: 1.2e-5, fromC: 20, toC: 120, lengthM: 10 });
    expect(result.growthMm).toBeCloseTo(12, 9);
    expect(result.meanCtePerK).toBeCloseTo(1.2e-5, 15);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['PST_MATERIAL_UNVERIFIED']);
  });

  it('a thermalStrain material model gives alpha dT L inside its validity range and refuses outside it', () => {
    const withMaterial = withModel(doc, 'mat', strainModel(1.2e-5));
    const result = data<Growth>(withMaterial, 'thermal_growth', { materialId: 'mat', fromC: 20, toC: 120, lengthM: 10 });
    expect(result.growthMm).toBeCloseTo(12, 9);
    expect(result.warnings).toEqual([]);
    expectRefusal(withMaterial, 'thermal_growth', { materialId: 'mat', fromC: 20, toC: 300, lengthM: 10 }, 'PST_TEMPERATURE_OUT_OF_TABLE');
  });

  it('a model on an unverified basis (typical) raises PST_MATERIAL_UNVERIFIED', () => {
    const typical = withModel(doc, 'typ', strainModel(1.2e-5, 'typical'));
    const result = data<Growth>(typical, 'thermal_growth', { materialId: 'typ', fromC: 20, toC: 120, lengthM: 10 });
    expect(result.warnings.map((warning) => warning.code)).toEqual(['PST_MATERIAL_UNVERIFIED']);
  });

  it('a secant cte model needs its reference temperature', () => {
    const form = { kind: 'polynomial', variable: 'T', coefficients: [1.2e-5], origin: 293.15 };
    const withMaterial = withModel(doc, 'cteMat', cteModel(form));
    expectRefusal(withMaterial, 'thermal_growth', { materialId: 'cteMat', fromC: 20, toC: 120, lengthM: 10 }, 'PST_MATERIAL_NO_DATA');
    const result = data<Growth>(withMaterial, 'thermal_growth', {
      materialId: 'cteMat',
      cteReferenceC: 20,
      fromC: 20,
      toC: 120,
      lengthM: 10,
    });
    expect(result.growthMm).toBeCloseTo(12, 9);
  });

  it('refuses an unknown material and a material without an expansion model', () => {
    expectRefusal(doc, 'thermal_growth', { materialId: 'ghost', fromC: 20, toC: 120, lengthM: 10 }, 'PST_MATERIAL_NOT_FOUND', 'materialId');
    const bare = execute(doc, 'create_material', {
      name: 'bare',
      density: 0.0078,
      color: '#999999',
      metalness: 1,
      roughness: 0.4,
    }).document;
    expectRefusal(bare, 'thermal_growth', { materialId: 'bare', fromC: 20, toC: 120, lengthM: 10 }, 'PST_MATERIAL_NO_DATA');
  });
});

describe('contract', () => {
  it('cteReferenceC without a material is refused', () => {
    expectRefusal(
      doc,
      'thermal_growth',
      { ...TABLE, cteReferenceC: 20, fromC: 21.111, toC: 100, lengthM: 1 },
      'PST_PARAM_INVALID',
      'cteReferenceC',
    );
  });

  it('a coefficient outside 1e-6..5e-5 /K raises PST_CTE_IMPLAUSIBLE (unit slip); a steel value does not', () => {
    expect(growth({ meanCtePerK: 12, fromC: 20, toC: 120, lengthM: 1 }).warnings.map((warning) => warning.code)).toContain(
      'PST_CTE_IMPLAUSIBLE',
    );
    expect(growth({ meanCtePerK: 1.2e-5, fromC: 20, toC: 120, lengthM: 1 }).warnings.map((warning) => warning.code)).not.toContain(
      'PST_CTE_IMPLAUSIBLE',
    );
    expect(growth({ ...TABLE, fromC: 21.111, toC: 204.444, lengthM: 1 }).warnings.map((warning) => warning.code)).not.toContain(
      'PST_CTE_IMPLAUSIBLE',
    );
  });

  it.each([
    ['no source', { fromC: 20, toC: 120, lengthM: 10 }],
    ['two sources', { ...TABLE, meanCtePerK: 1e-5, fromC: 21.111, toC: 120, lengthM: 10 }],
  ])('%s -> PST_PARAM_INVALID', (_label, params) => {
    expectRefusal(doc, 'thermal_growth', params, 'PST_PARAM_INVALID', 'table');
  });

  it('rejects a non-positive length and an unknown table at the schema', () => {
    for (const params of [
      { ...TABLE, fromC: 21.111, toC: 100, lengthM: 0 },
      { table: 'stainless', fromC: 21.111, toC: 100, lengthM: 1 },
    ]) {
      const result = execute(doc, 'thermal_growth', params);
      expect(result.rejected).toBe(true);
      expect(result.document).toBe(doc);
    }
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'thermal_growth', { ...TABLE, fromC: 21.111, toC: 200, lengthM: 5 }));
  });
});
