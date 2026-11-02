/**
 * Plant 07 PST M1: pipe_stress_allowables. VC-PST-03 (f by edition, 1e-5 abs, grade A), VC-PST-05 (S_A eq. 1a / 1b, 1e-6 rel, grade A) and
 * VC-PST-13 (occasional arithmetic, rule grade B). Hand checks: 6 x 7000^-0.2 = 1.021249; 0.6 x (1.25 x 275.8 - 40) = 182.85; 1.33 x 137.9 = 183.407.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { expectRel, referenceData } from './stressFixtures';

interface Allowables {
  rule: string;
  f: number;
  fRaw: number;
  fCap: number;
  limited: string;
  SA1aMPa: number;
  SA1bMPa: number | null;
  SAMPa: number;
  equation: string;
  occasionalFactor: number;
  occasionalMPa: number;
  defaulted: string[];
  warnings: Array<{ code: string }>;
  reviewRequired: boolean;
  ruleRows: Array<{ id: string; grade: string }>;
}

const doc = createEmptyDocument();
const BASE = { ScMPa: 137.9, ShMPa: 137.9 };
const allowables = (params: Record<string, unknown>): Allowables => data<Allowables>(doc, 'pipe_stress_allowables', { ...BASE, ...params });

describe('VC-PST-03 f by edition (grade A)', () => {
  const derived = referenceData<{ derivedValues: Array<Record<string, number | string>> }>('code_rules_b313.json').derivedValues;
  const at = (n: number): Record<string, number | string> =>
    derived.find((row) => row['vc'] === 'VC-PST-03' && row['N'] === n) as Record<string, number | string>;

  it('N 7000: 1.021249 with the 1.2 cap allowed, 1.0 without, 1.045516 in 2022', () => {
    const row = at(7000);
    expect(
      Math.abs(allowables({ cycles: 7000, rule: 'B31.3-2018', ferrousLowStrength: true }).f - (row['f_pre2022_fm1p2'] as number)),
    ).toBeLessThanOrEqual(1e-5);
    expect(allowables({ cycles: 7000, rule: 'B31.3-2018', ferrousLowStrength: false }).f).toBe(row['f_pre2022_fm1p0']);
    expect(
      Math.abs(allowables({ cycles: 7000, rule: 'B31.3-2022', ferrousLowStrength: true }).f - (row['f_2022_raw'] as number)),
    ).toBeLessThanOrEqual(1e-5);
  });

  it('N 100000: 0.6 before 2022, 0.430887 from 2022', () => {
    const row = at(100000);
    expect(Math.abs(allowables({ cycles: 100000, rule: 'B31.3-2020' }).f - (row['f_pre2022'] as number))).toBeLessThanOrEqual(1e-5);
    expect(Math.abs(allowables({ cycles: 100000, rule: 'B31.3-2022' }).f - (row['f_2022'] as number))).toBeLessThanOrEqual(1e-5);
    expect(Math.abs(allowables({ cycles: 100000, rule: 'B31.3-2024' }).f - (row['f_2022'] as number))).toBeLessThanOrEqual(1e-5);
  });

  it('N 2e8 hits the 0.15 floor (raw 0.131203)', () => {
    const result = allowables({ cycles: 2e8, rule: 'B31.3-2018' });
    expect(result.f).toBe(0.15);
    expect(result.limited).toBe('floor');
    expect(Math.abs(result.fRaw - (at(2e8)['f_pre2022_raw'] as number))).toBeLessThanOrEqual(1e-5);
  });

  it('the 1.2 cap is reached at 3125 cycles (pre-2022) and 4630 cycles (2022)', () => {
    expect(Math.abs(allowables({ cycles: 3125, rule: 'B31.3-2018', ferrousLowStrength: true }).fRaw - 1.2)).toBeLessThanOrEqual(1e-5);
    expect(Math.abs(allowables({ cycles: 4630, rule: 'B31.3-2022', ferrousLowStrength: true }).fRaw - 1.199968)).toBeLessThanOrEqual(1e-5);
    const capped = allowables({ cycles: 1000, rule: 'B31.3-2018', ferrousLowStrength: true });
    expect([capped.f, capped.limited]).toEqual([1.2, 'cap']);
  });

  it('B31.1 never caps above 1.0', () => {
    const result = allowables({ cycles: 1000, rule: 'B31.1-2018', ferrousLowStrength: true });
    expect([result.f, result.fCap, result.limited]).toEqual([1, 1, 'cap']);
    expect(result.ruleRows.map((row) => row.id)).toContain('B311-F');
  });
});

describe('VC-PST-05 S_A by eq. (1a) and (1b) (grade A)', () => {
  const cases = referenceData<{ derivedValues: Array<Record<string, number | string>> }>('code_rules_b313.json').derivedValues.filter(
    (row) => row['vc'] === 'VC-PST-05',
  );

  it.each([
    [1.0, 7000],
    [0.6, 100000],
  ])('f %s (N %s): SA matches the reference to 1e-6', (factor, cycles) => {
    const row = cases.find((entry) => entry['f'] === factor) as Record<string, number | string>;
    const result = allowables({ cycles, rule: 'B31.3-2018', SLMPa: row['SL_MPa'] });
    expect(result.f).toBeCloseTo(factor, 12);
    expectRel(result.SA1aMPa, row['SA_1a_MPa'] as number, 1e-6, '1a');
    expectRel(result.SA1bMPa as number, row['SA_1b_MPa'] as number, 1e-6, '1b');
    expect(result.equation).toBe('1b');
    expect(result.SAMPa).toBe(result.SA1bMPa);
    expect(result.ruleRows.map((rule) => rule.id)).toEqual(expect.arrayContaining(['B313-SA-1A', 'B313-SA-1B']));
  });

  it('without SL only eq. (1a) is reported; with SL >= Sh eq. (1a) governs', () => {
    const without = allowables({ cycles: 7000, rule: 'B31.3-2018' });
    expect([without.equation, without.SA1bMPa]).toEqual(['1a', null]);
    expect(without.ruleRows.map((rule) => rule.id)).not.toContain('B313-SA-1B');
    const heavy = allowables({ cycles: 7000, rule: 'B31.3-2018', SLMPa: 150 });
    expect(heavy.equation).toBe('1a');
    expect(heavy.SA1bMPa).toBeNull();
    expect(heavy.warnings.map((warning) => warning.code)).toEqual(['PST_SUSTAINED_EXCEEDS_SH']);
    expect(allowables({ cycles: 7000, rule: 'B31.3-2018', SLMPa: 100 }).warnings).toEqual([]);
    expect(heavy.ruleRows.map((rule) => rule.id)).not.toContain('B313-SA-1B');
  });
});

describe('VC-PST-13 occasional limit (rule grade B)', () => {
  it('B31.3: 1.33 Sh = 183.407 MPa; sustained 80 + occasional 60 gives ratio 0.76333', () => {
    const result = allowables({ cycles: 7000, rule: 'B31.3-2018' });
    expectRel(result.occasionalMPa, 183.407, 1e-5);
    expectRel((80 + 60) / result.occasionalMPa, 0.76333, 1e-5);
    expect(result.ruleRows.find((rule) => rule.id === 'B313-OCC')?.grade).toBe('B');
  });

  it('sustainedMPa 80 + occasionalLoadMPa 60 gives ratio 0.76333 (ok); 150 + 60 is over the limit', () => {
    const result = data<
      Allowables & { occasionalRatio: number; occasionalOk: boolean; occasionalSumMPa: number; occasionalRuleGrade: string }
    >(doc, 'pipe_stress_allowables', { ...BASE, cycles: 7000, rule: 'B31.3-2018', sustainedMPa: 80, occasionalLoadMPa: 60 });
    expectRel(result.occasionalRatio, 0.76333, 1e-5);
    expect([result.occasionalSumMPa, result.occasionalOk, result.occasionalRuleGrade]).toEqual([140, true, 'B']);
    const over = data<{ occasionalOk: boolean }>(doc, 'pipe_stress_allowables', {
      ...BASE,
      cycles: 7000,
      rule: 'B31.3-2018',
      sustainedMPa: 150,
      occasionalLoadMPa: 60,
    });
    expect(over.occasionalOk).toBe(false);
    expect(allowables({ cycles: 7000, rule: 'B31.3-2018' })).not.toHaveProperty('occasionalRatio');
  });

  it('the occasional stresses come as a pair', () => {
    expectRefusal(
      doc,
      'pipe_stress_allowables',
      { ...BASE, cycles: 7000, rule: 'B31.3-2018', sustainedMPa: 80 },
      'PST_PARAM_INVALID',
      'occasionalLoadMPa',
    );
  });

  it('B31.3-2022 f rule row is grade B (secondary sources, constant 20 not read in a primary text)', () => {
    expect(allowables({ cycles: 7000, rule: 'B31.3-2022' }).ruleRows.find((row) => row.id === 'B313-F-2022')?.grade).toBe('B');
  });

  it('B31.1: 1.15 Sh by default (listed as defaulted), 1.2 Sh for events up to 1 percent', () => {
    const byDefault = allowables({ cycles: 7000, rule: 'B31.1-2018' });
    expect([byDefault.occasionalFactor, byDefault.defaulted]).toEqual([
      1.15,
      ['ferrousLowStrength=false (cap 1.0)', 'occasionalEvents=upTo10Percent (1.15 Sh)'],
    ]);
    expectRel(allowables({ cycles: 7000, rule: 'B31.1-2018', occasionalEvents: 'upTo1Percent' }).occasionalMPa, 1.2 * 137.9, 1e-12);
  });
});

describe('contract', () => {
  it('lists the defaulted cap and always sets reviewRequired', () => {
    const result = allowables({ cycles: 7000, rule: 'B31.3-2018' });
    expect(result.defaulted).toEqual(['ferrousLowStrength=false (cap 1.0)']);
    expect(result.reviewRequired).toBe(true);
    expect(allowables({ cycles: 7000, rule: 'B31.3-2018', ferrousLowStrength: false }).defaulted).toEqual([]);
  });

  it('occasionalEvents on a B31.3 rule set is refused', () => {
    expectRefusal(
      doc,
      'pipe_stress_allowables',
      { ...BASE, cycles: 7000, rule: 'B31.3-2018', occasionalEvents: 'upTo1Percent' },
      'PST_PARAM_INVALID',
      'occasionalEvents',
    );
  });

  it('rejects a missing edition, zero cycles and a non-positive stress at the schema', () => {
    for (const params of [
      { ...BASE, cycles: 7000 },
      { ...BASE, cycles: 0, rule: 'B31.3-2018' },
      { ScMPa: 0, ShMPa: 100, cycles: 10, rule: 'B31.3-2018' },
    ]) {
      const result = execute(doc, 'pipe_stress_allowables', params);
      expect(result.rejected).toBe(true);
      expect(result.document).toBe(doc);
    }
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'pipe_stress_allowables', { ...BASE, cycles: 7000, rule: 'B31.3-2018' }));
  });
});
