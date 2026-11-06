/**
 * PST-M5b `import_pipe_material_data`: a code material table becomes PHY-01 models; the thermal strain feeds `thermal_growth` and the stress model
 * (VC-PST-04: 30 m of carbon steel 70 -> 400 degF grows 67.52 mm), Sh(T) and E(T) interpolate linearly inside the rows and are refused outside.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { apply, expectRefusal } from '../../../helpers/commandAssertions';
import { baseDoc, withModel, withPipe } from './m3Fixtures';
import { expectRel, referenceData } from './stressFixtures';

interface CarbonRows {
  rows: [number, number, number][];
}
const carbon = referenceData<CarbonRows>('thermal_expansion_carbon_steel.json').rows;
const fToC = (f: number): number => (f - 32) / 1.8;
const REFERENCE_C = fToC(70);
const SOURCE = { citation: 'ASME B31.3 Table C-1 as quoted by PSI materials.csv', locator: 'carbon steel group' };
const LICENCE = 'test fixture: values read from the validation pack';

/** The validation pack's carbon steel rows by mean coefficient (1/degF -> 1/K). */
const byMeanCte = carbon.map(([f, alpha]) => ({ tempC: fToC(f), ShMPa: 138, meanCtePerK: alpha * 1.8 }));
/** The same rows by tabulated growth (in per 100 ft -> mm per m). */
const byGrowth = carbon.map(([f, , growth]) => ({ tempC: fToC(f), ShMPa: 138, growthMmPerM: (growth * 1000) / 1200 }));

const importRows = (doc: CadDocument, rows: unknown[], extra: Record<string, unknown> = {}): CadDocument =>
  apply(doc, 'import_pipe_material_data', {
    materialId: 'A53-A',
    designation: 'ASTM A53 Gr A',
    rows,
    referenceTempC: REFERENCE_C,
    source: SOURCE,
    licence: LICENCE,
    ...extra,
  });

const growth30m = (doc: CadDocument): { growthMm: number; warnings: { code: string }[] } => {
  const result = execute(doc, 'thermal_growth', { materialId: 'A53-A', fromC: REFERENCE_C, toC: fToC(400), lengthM: 30 });
  expect(result.rejected, result.summary).toBeUndefined();
  return result.data as { growthMm: number; warnings: { code: string }[] };
};

describe('import_pipe_material_data: thermal strain (VC-PST-04)', () => {
  it('mean coefficients give 30 m x (70 -> 400 degF) = 67.52 mm through thermal_growth, flagged unverified', () => {
    const doc = importRows(createEmptyDocument(), byMeanCte);
    const grown = growth30m(doc);
    expect(Math.abs(grown.growthMm - 67.52)).toBeLessThan(0.05);
    expect(grown.warnings.map((warning) => warning.code)).toContain('PST_MATERIAL_UNVERIFIED');
  });

  it('tabulated growth (mm/m) gives the same growth as the coefficients to the table rounding (1e-4)', () => {
    const fromCte = growth30m(importRows(createEmptyDocument(), byMeanCte)).growthMm;
    const fromGrowth = growth30m(importRows(createEmptyDocument(), byGrowth)).growthMm;
    expectRel(fromGrowth, fromCte, 1e-4, 'growth vs mean coefficient');
    expect(Math.abs(fromGrowth - 67.52)).toBeLessThan(0.05);
  });

  it('the stress model reads the strain: set_pipe_operating_conditions T1 = 400 degF strain is the table strain from the reference', () => {
    const doc = importRows(baseDoc(), byMeanCte);
    const pipe = withPipe(
      doc,
      [
        [0, 0, 3000],
        [4000, 0, 3000],
      ],
      114.3,
    );
    const model = withModel(pipe.doc, [pipe.id]);
    const set = execute(model.doc, 'set_pipe_operating_conditions', {
      modelId: model.id,
      installTempC: REFERENCE_C,
      temperatures: [{ name: 'T1', tempC: fToC(400) }],
      wallMm: 6.02,
      material: { youngsModulusMPa: 200000, ShMPa: 138, ScMPa: 138, thermal: { materialId: 'A53-A' } },
    });
    expect(set.rejected, set.summary).toBeUndefined();
    expectRel((set.data as { strains: Record<string, number> }).strains['T1'] as number, 6.82e-6 * 330, 1e-9, 'strain');
  });
});

describe('import_pipe_material_data: allowable stress and modulus tables', () => {
  // test values, not code data: the arithmetic of the table (linear inside the rows, refused outside) is what is checked
  const rows = [
    { tempC: 20, ShMPa: 138, EGPa: 203 },
    { tempC: 100, ShMPa: 138, EGPa: 199 },
    { tempC: 200, ShMPa: 130, EGPa: 194 },
    { tempC: 300, ShMPa: 124, EGPa: 190 },
  ];
  const doc = importRows(createEmptyDocument(), rows, { SMYSMPa: 240, SMTSMPa: 415, densityKgM3: 7850, referenceTempC: undefined });

  const at = (property: string, tempC: number, unit: string): ReturnType<typeof execute> =>
    execute(doc, 'evaluate_property', { material: 'A53-A', property, at: { T: { value: tempC, unit: 'degC' } }, outputUnit: unit });

  it('S_h(T) and E(T) interpolate linearly between rows: 150 degC gives 134 MPa and 196.5 GPa', () => {
    expectRel((at('pipingAllowableStress', 150, 'MPa').data as { value: number }).value, 134, 1e-9, 'Sh');
    expectRel((at('E', 150, 'GPa').data as { value: number }).value, 196.5, 1e-9, 'E');
    expectRel((at('pipingAllowableStress', 300, 'MPa').data as { value: number }).value, 124, 1e-9, 'Sh at the last row');
  });

  it('is refused outside the rows (never extrapolated) and every value is unverified', () => {
    expect(at('pipingAllowableStress', 350, 'MPa').rejected).toBe(true);
    expect(at('E', 10, 'GPa').rejected).toBe(true);
    expect((at('pipingAllowableStress', 150, 'MPa').data as { unverified: boolean }).unverified).toBe(true);
  });

  it('stores the yield and tensile strengths and replaces the models on a second import (same ids, new values)', () => {
    const models = doc.materials?.['A53-A']?.propertyModels ?? [];
    expect(models.map((model) => model.id).sort()).toEqual(['E.code', 'Ftu.code', 'Fty.code', 'S.code']);
    const again = importRows(
      doc,
      rows.map((row) => ({ ...row, ShMPa: row.ShMPa - 10 })),
    );
    expect(again.materials?.['A53-A']?.propertyModels).toHaveLength(4);
    const result = execute(again, 'evaluate_property', {
      material: 'A53-A',
      property: 'pipingAllowableStress',
      at: { T: { value: 100, unit: 'degC' } },
      outputUnit: 'MPa',
    });
    expectRel((result.data as { value: number }).value, 128, 1e-9, 'replaced Sh');
  });

  it('reports the models, the range and what was defaulted; no thermal strain model without expansion data', () => {
    const result = execute(createEmptyDocument(), 'import_pipe_material_data', {
      materialId: 'M',
      designation: 'test',
      rows,
      source: SOURCE,
      licence: LICENCE,
    });
    const data = result.data as { models: { property: string }[]; rangeC: number[]; defaulted: string[]; referenceTempC: number | null };
    expect(data.models.map((model) => model.property)).toEqual(['pipingAllowableStress', 'E']);
    expect(data.rangeC).toEqual([20, 300]);
    expect(data.referenceTempC).toBeNull();
    expect(data.defaulted).toEqual(['densityKgM3=7850']);
  });
});

describe('import_pipe_material_data: refusals', () => {
  const doc = createEmptyDocument();
  const base = (rows: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    materialId: 'M',
    designation: 'test',
    rows,
    source: SOURCE,
    licence: LICENCE,
    ...extra,
  });
  const good = [
    { tempC: 20, ShMPa: 100, EGPa: 200, meanCtePerK: 1e-5 },
    { tempC: 100, ShMPa: 90, EGPa: 190, meanCtePerK: 1.1e-5 },
  ];

  it('PST_TABLE_INVALID: rows count, order, partial families, both expansion forms, reference above the rows', () => {
    expectRefusal(doc, 'import_pipe_material_data', base([good[0]]), 'PST_TABLE_INVALID');
    expectRefusal(
      doc,
      'import_pipe_material_data',
      base(Array.from({ length: 201 }, (_, i) => ({ tempC: i, ShMPa: 100 }))),
      'PST_TABLE_INVALID',
    );
    expectRefusal(doc, 'import_pipe_material_data', base([good[1], good[0]]), 'PST_TABLE_INVALID');
    expectRefusal(doc, 'import_pipe_material_data', base([good[0], { tempC: 100, ShMPa: 90 }]), 'PST_TABLE_INVALID');
    expectRefusal(doc, 'import_pipe_material_data', base([good[0], { tempC: 100, ShMPa: 90, EGPa: 190 }]), 'PST_TABLE_INVALID');
    expectRefusal(doc, 'import_pipe_material_data', base([{ ...good[0], growthMmPerM: 1 }, good[1]]), 'PST_TABLE_INVALID');
    expectRefusal(doc, 'import_pipe_material_data', base(good, { referenceTempC: 150 }), 'PST_TABLE_INVALID');
  });

  it('rejects bad parameters (CMD_INVALID_PARAMS) and a reserved material name without changing the document', () => {
    expectRefusal(doc, 'import_pipe_material_data', base([{ tempC: 20, ShMPa: -1 }, good[1]]), 'CMD_INVALID_PARAMS');
    expectRefusal(doc, 'import_pipe_material_data', base(good, { licence: '' }), 'CMD_INVALID_PARAMS');
    expectRefusal(doc, 'import_pipe_material_data', base(good, { materialId: '__proto__' }), 'CMD_RESERVED_ID');
    expectRefusal(doc, 'import_pipe_material_data', { ...base(good), source: undefined }, 'CMD_INVALID_PARAMS');
  });

  it('is pure', () => {
    const before = JSON.stringify(doc);
    const result = execute(doc, 'import_pipe_material_data', base(good));
    expect(result.document).not.toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
