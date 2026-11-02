/**
 * Plant 07 PST M1: pipe_sif. VC-PST-01 (bend h, k, ii, io against sif_flexibility.json, 1e-4 rel, grade A) and VC-PST-02 (tee and olet arithmetic
 * against closed_forms_output.json = PSI test_sifs.py, grade B reported). Hand check NPS 6 Sch 40 LR: r2 = (6.625 - 0.280) / 2 = 3.1725 in,
 * h = 0.280 x 9 / 3.1725^2 = 0.250379, ii = 0.9 / h^(2/3) = 2.26557.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { expectRel, MM_PER_IN, referenceData } from './stressFixtures';

interface SifCase {
  id: string;
  inputs: { DoIn?: number; Tin?: number; R1In?: number; DoMm?: number; Tmm?: number; R1Mm?: number };
  expected: { h: number; k: number; ii: number; io: number };
}
interface Sif {
  h: number | null;
  k: number;
  ii: number;
  io: number;
  grade: string;
  rule: string;
  reviewRequired: boolean;
  warnings: Array<{ code: string }>;
  ruleRows: Array<{ id: string; grade: string }>;
}

const doc = createEmptyDocument();
const sif = (params: Record<string, unknown>): Sif => data<Sif>(doc, 'pipe_sif', params);

describe('VC-PST-01 bend factors (grade A)', () => {
  const { cases } = referenceData<{ cases: SifCase[] }>('sif_flexibility.json');

  it.each(cases.map((entry) => [entry.id, entry] as const))('%s matches the reference to 1e-4', (_id, entry) => {
    const { inputs, expected } = entry;
    const toMm = inputs.DoIn === undefined ? 1 : MM_PER_IN;
    const result = sif({
      component: 'elbow',
      odMm: (inputs.DoIn ?? inputs.DoMm ?? 0) * toMm,
      wallMm: (inputs.Tin ?? inputs.Tmm ?? 0) * toMm,
      bendRadiusMm: (inputs.R1In ?? inputs.R1Mm ?? 0) * toMm,
      rule: 'B31.3-2018',
    });
    for (const key of ['h', 'k', 'ii', 'io'] as const) expectRel(result[key] as number, expected[key], 1e-4, `${entry.id} ${key}`);
    expect(result.grade).toBe('A');
    expect(result.reviewRequired).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('a bend and an elbow share the formula', () => {
    const base = { odMm: 168.3, wallMm: 7.11, bendRadiusMm: 228.6, rule: 'B31.3-2018' };
    const pick = (result: Sif): number[] => [result.h as number, result.k, result.ii, result.io];
    expect(pick(sif({ component: 'bend', ...base }))).toEqual(pick(sif({ component: 'elbow', ...base })));
  });

  it('floors every factor at 1 for a stiff thick bend', () => {
    const result = sif({ component: 'bend', odMm: 100, wallMm: 20, bendRadiusMm: 1000, rule: 'B31.3-2016' });
    expect([result.k, result.ii, result.io]).toEqual([1, 1, 1]);
  });

  it('B31.1 returns one SIF for both planes (the in-plane value)', () => {
    const result = sif({ component: 'elbow', odMm: 168.3, wallMm: 7.11, bendRadiusMm: 228.6, rule: 'B31.1-2018' });
    expectRel(result.ii, 2.2665, 1e-4);
    expect(result.io).toBe(result.ii);
  });
});

describe('VC-PST-02 tees and olets (PSI NPS 3, T 0.216 in, grade B)', () => {
  const { tee_nps3: tee } = referenceData<{ tee_nps3: Record<string, number> }>('closed_forms_output.json');
  const nps3 = { odMm: 3.5 * MM_PER_IN, wallMm: 0.216 * MM_PER_IN, rule: 'B31.3-2018' };

  it.each([
    ['unreinforced_tee', {}, 'unreinforced'],
    ['welding_tee', {}, 'welding_31'],
    ['weldolet', {}, 'weldolet_33'],
    ['reinforced_tee', { padMm: 0.25 * MM_PER_IN }, 'reinforced_pad_0p25'],
  ] as const)('%s out-of-plane SIF equals the closed form', (component, extra, key) => {
    const result = sif({ component, ...nps3, ...extra });
    expectRel(result.io, tee[key] as number, 1e-4, component);
    expect(result.k).toBe(1);
    expectRel(result.ii, Math.max(1, 0.75 * result.io + 0.25), 1e-12);
    expect(result.grade).toBe('B');
    expect(result.ruleRows.map((row) => row.grade)).toEqual(['B']);
  });

  it('B31.1 tees carry one SIF (ii = io)', () => {
    const result = sif({ component: 'welding_tee', ...nps3, rule: 'B31.1-2018' });
    expect(result.ii).toBe(result.io);
  });

  it('butt weld is 1.0 with no h', () => {
    const result = sif({ component: 'butt_weld', ...nps3 });
    expect([result.h, result.k, result.ii, result.io]).toEqual([null, 1, 1, 1]);
  });
});

describe('editions that need B31J (VC-PST-19 stays TBD)', () => {
  const elbow = { component: 'elbow', odMm: 168.3, wallMm: 7.11, bendRadiusMm: 228.6 };

  it.each(['B31.3-2020', 'B31.3-2022', 'B31.1-2020'])(
    '%s returns the appendix D value with a non-hideable PST_SIF_EDITION warning',
    (rule) => {
      const result = sif({ ...elbow, rule });
      expect(result.warnings.map((warning) => warning.code)).toEqual(['PST_SIF_EDITION']);
      expect(result.ruleRows.map((row) => row.id)).toContain('SIF-B31J');
      expectRel(result.ii, 2.2665, 1e-4);
    },
  );

  it('rule user returns the supplied factors unchanged and unverified', () => {
    const result = data<Sif & { unverified: boolean; source: string }>(doc, 'pipe_sif', {
      ...elbow,
      rule: 'user',
      userSif: { ii: 3.1, io: 2.7, k: 5.5, source: 'B31J-2017 table (licensed copy)' },
    });
    expect([result.ii, result.io, result.k]).toEqual([3.1, 2.7, 5.5]);
    expect(result.unverified).toBe(true);
    expect(result.source).toContain('B31J');
    expect(result.warnings.map((warning) => warning.code)).toEqual(['PST_SIF_UNVERIFIED']);
  });

  it('a reducer accepts user factors (no read source for its formula)', () => {
    const result = sif({
      component: 'reducer',
      odMm: 168.3,
      wallMm: 7.11,
      rule: 'user',
      userSif: { ii: 1.5, io: 1.5, k: 1, source: 'vendor' },
    });
    expect(result.ii).toBe(1.5);
  });
});

describe('refusals (unchanged document, stable code, path)', () => {
  const elbow = { component: 'elbow', odMm: 168.3, wallMm: 7.11, bendRadiusMm: 228.6, rule: 'B31.3-2018' };

  it.each([
    ['elbow without a radius', { ...elbow, bendRadiusMm: undefined }, 'bendRadiusMm'],
    ['reinforced tee without a pad', { ...elbow, component: 'reinforced_tee' }, 'padMm'],
    ['sweepolet', { ...elbow, component: 'sweepolet' }, 'component'],
    ['reducer', { ...elbow, component: 'reducer' }, 'component'],
    ['wall at half the diameter', { ...elbow, wallMm: 84.15 }, 'wallMm'],
    ['rule user without factors', { ...elbow, rule: 'user' }, 'userSif'],
  ])('%s -> PST_PARAM_INVALID', (_label, params, path) => {
    expectRefusal(doc, 'pipe_sif', params, 'PST_PARAM_INVALID', path);
  });

  it('rejects an unknown rule and a missing edition at the schema', () => {
    for (const rule of ['B31.3', 'B31.3-1999', undefined]) {
      const result = execute(doc, 'pipe_sif', { ...elbow, rule });
      expect(result.rejected).toBe(true);
      expect(result.document).toBe(doc);
    }
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'pipe_sif', elbow));
  });
});
