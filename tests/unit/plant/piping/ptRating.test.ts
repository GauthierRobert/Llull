/** Plant 01 PSC M1: `pt_rating` (VC-PSC-07) against the B16.5 group 1.1 pack rows. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { packJson } from './packData';

const doc = createEmptyDocument();
type Row = Record<string, unknown> & { bracket: Array<{ temperatureC: number }> };
const rate = (params: Record<string, unknown>): Row =>
  data<Row>(doc, 'pt_rating', { standard: 'ASME B16.5', materialGroup: '1.1', ...params });
const near = (actual: unknown, expected: number, tolerance: number): void =>
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);

describe('pt_rating (VC-PSC-07)', () => {
  it('returns the tabulated group 1.1 values: Class 150 19.6 bar and Class 300 51.1 bar below 38 degC', () => {
    const cl150 = rate({ class: 150, temperatureC: 38 });
    near(cl150['ratingBar'], 19.6, 1e-3);
    expect(cl150['method']).toBe('tabulated');
    expect(cl150['verified']).toBe(true);
    const cl300 = rate({ class: 300, temperatureC: 20 });
    near(cl300['ratingBar'], 51.1, 1e-3);
    expect(cl300['method']).toBe('first band');
  });

  it('interpolates linearly: Class 150 at 45 degC = 19.3667 bar from the 38 and 50 degC rows', () => {
    const row = rate({ class: 150, temperatureC: 45 });
    near(row['ratingBar'], 19.6 + (19.2 - 19.6) * (7 / 12), 5e-4);
    near(row['ratingBar'], 19.3667, 5e-4);
    expect(row['method']).toBe('interpolated');
    expect(row.bracket.map((r) => r.temperatureC)).toEqual([38, 50]);
    expect(row['verified']).toBe(true);
  });

  it('reproduces every pack row (bar) and marks the grade-B rows unverified', () => {
    const rows = packJson<{ rows: Array<{ class: number; temperatureC: number; ratingBar: number; grade: string }> }>(
      'asme_b16_5_pt_group_1_1.json',
    ).rows;
    for (const pack of rows) {
      const row = rate({ class: pack.class, temperatureC: pack.temperatureC });
      near(row['ratingBar'], pack.ratingBar, 1e-9);
      expect(row['verified']).toBe(pack.grade === 'A');
    }
  });

  it('propagates unverified when a bracketing row is grade B (Class 150 at 75 degC)', () => {
    const row = rate({ class: 150, temperatureC: 75 });
    expect(row['verified']).toBe(false);
    expect((row['warnings'] as Array<{ code: string }>)[0]?.code).toBe('PSC_DATA_UNVERIFIED');
    expect(ok(doc, 'pt_rating', { standard: 'ASME B16.5', materialGroup: '1.1', class: 150, temperatureC: 75 }).summary).toContain(
      'UNVERIFIED',
    );
  });

  it('gives the tabulated 285 psig for Class 150 at 100 degF and converts elsewhere, stating the factor', () => {
    const tabulated = rate({ class: 150, temperature: { value: 100, unit: 'F' }, unit: 'psi' });
    expect(tabulated['ratingPsi']).toBe(285);
    expect(tabulated['method']).toBe('tabulated psig');
    const converted = rate({ class: 150, temperatureC: 45, unit: 'psi' });
    near(converted['ratingPsi'], (19.6 + (19.2 - 19.6) * (7 / 12)) / 0.0689475729, 1e-9);
    expect(converted['conversion']).toContain('0.0689475729');
    near(rate({ class: 300, temperatureC: 20, unit: 'psi' })['ratingPsi'], 740, 0);
  });

  it('accepts a Fahrenheit temperature (100 degF = 37.78 degC is in the first band)', () => {
    const row = rate({ class: 150, temperature: { value: 100, unit: 'F' } });
    near(row['ratingBar'], 19.6, 1e-9);
    near(row['temperatureC'], 37.7778, 1e-4);
  });

  it('refuses a temperature outside the table, an unknown class, table and a bad temperature spec', () => {
    const base = { standard: 'ASME B16.5', materialGroup: '1.1' };
    expectRefusal(doc, 'pt_rating', { ...base, class: 150, temperatureC: 250 }, 'PSC_PT_TEMPERATURE_OUT_OF_TABLE', 'temperatureC');
    expectRefusal(doc, 'pt_rating', { ...base, class: 150, temperatureC: -50 }, 'PSC_PT_TEMPERATURE_OUT_OF_TABLE');
    expectRefusal(doc, 'pt_rating', { ...base, class: 300, temperatureC: 100 }, 'PSC_PT_TEMPERATURE_OUT_OF_TABLE');
    expectRefusal(doc, 'pt_rating', { ...base, class: 125, temperatureC: 20 }, 'PSC_CATALOG_ROW_MISSING', 'class');
    expectRefusal(doc, 'pt_rating', { ...base, materialGroup: '2.1', class: 150, temperatureC: 20 }, 'PSC_CATALOG_ROW_MISSING', 'standard');
    expectRefusal(doc, 'pt_rating', { ...base, class: 150 }, 'PSC_UNIT_INVALID');
    expectRefusal(doc, 'pt_rating', { ...base, class: 150, temperatureC: 20, temperature: { value: 20, unit: 'C' } }, 'PSC_UNIT_INVALID');
  });

  it('is pure', () => {
    expectPure(doc, () => rate({ class: 150, temperatureC: 45 }));
  });
});
