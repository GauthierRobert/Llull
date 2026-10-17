/** VC-MATL-08: linear fits on the pinned Treloar table, residuals per mode, stability and the fit_material_model contract. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { expectCase, packCase } from '../benchmarkCases';
import { PACK, SOURCE, run, codeOf, withMaterial } from './materialFixtures';
import { nominalStress, polynomialDerivatives } from '@core/model/materialLaws/hyperelastic';
import { resolveHyper, type HyperLaw } from '@core/model/materialLaws/hyperResolve';

type Rows = number[][];
const TRELOAR: Record<'UT' | 'ET' | 'PS', Rows> = { UT: [], ET: [], PS: [] };
for (const line of readFileSync(`docs/physics/${PACK}/validation/treloar_1944_steinmann2012.csv`, 'utf8').split('\n')) {
  if (line.startsWith('#') || line.startsWith('mode') || line.trim() === '') continue;
  const [mode, stretch, stress] = line.split(',');
  TRELOAR[mode as 'UT' | 'ET' | 'PS'].push([Number(stretch), Number(stress)]);
}

const test = (mode: 'UT' | 'ET' | 'PS'): Record<string, unknown> => ({
  mode: { UT: 'uniaxial', ET: 'equibiaxial', PS: 'planar' }[mode],
  rows: TRELOAR[mode],
  xMeasure: 'stretch',
  yMeasure: 'nominal_stress',
  units: { y: 'MPa' },
});
const ALL = [test('UT'), test('ET'), test('PS')];
const doc = createEmptyDocument();

interface FitData {
  model: Record<string, { value: number } | unknown>;
  fit: { residual: { rms: number }; conditionNumber: number; datasetSha256: string; method: string };
  validity: unknown[];
  basis: string;
  residualsPerTest: { mode: string; rms: number; maxAbs: number; count: number }[];
  stability: { drucker: Record<string, { tension: number | null; compression: number | null }> };
  defaults: { name: string }[];
  warnings: { code: string }[];
  unverified: boolean;
  reviewRequired: boolean;
}
const fit = (params: Record<string, unknown>): FitData => run(doc, 'fit_material_model', params).data as FitData;
const coefficient = (data: FitData, key: string): number => (data.model[key] as { value: number }).value;

describe('Treloar linear fits (VC-MATL-08)', () => {
  it('fits Neo-Hooke to uniaxial data only and warns about one mode', () => {
    const data = fit({ kind: 'hyper_neo_hooke', tests: [test('UT')] });
    expectCase(PACK, 'VC-MATL-08/treloarFit/neoHooke_UT', { C10: coefficient(data, 'C10') });
    expect(data.warnings.map((w) => w.code)).toContain('MATL_FIT_INSUFFICIENT_MODES');
    const expected = packCase(PACK, 'VC-MATL-08/treloarFit/neoHooke_all')['rmsPerModeMPa'] as Record<string, number>;
    const all = fit({ kind: 'hyper_neo_hooke', tests: ALL });
    expect(all.residualsPerTest.map((r) => r.mode)).toEqual(['UT', 'ET', 'PS']);
    all.residualsPerTest.forEach((r) => expect(r.rms).toBeCloseTo(expected[r.mode] ?? Number.NaN, 5));
    expect(all.warnings.map((w) => w.code)).not.toContain('MATL_FIT_INSUFFICIENT_MODES');
    expectCase(PACK, 'VC-MATL-08/treloarFit/neoHooke_all', { C10: coefficient(all, 'C10') });
  });

  it('fits Mooney-Rivlin and Yeoh to all modes with the reported RMS and Drucker limits', () => {
    for (const [kind, id, keys] of [
      ['hyper_mooney_rivlin', 'mooneyRivlin_all', ['C10', 'C01']],
      ['hyper_yeoh', 'yeoh_all', ['C10', 'C20', 'C30']],
    ] as const) {
      const data = fit({ kind, tests: ALL });
      const expected = packCase(PACK, `VC-MATL-08/treloarFit/${id}`);
      expectCase(PACK, `VC-MATL-08/treloarFit/${id}`, Object.fromEntries(keys.map((key) => [key, coefficient(data, key)])));
      const rms = expected['rmsPerModeMPa'] as Record<string, number>;
      data.residualsPerTest.forEach((r) => expect(r.rms).toBeCloseTo(rms[r.mode] ?? Number.NaN, 5));
      expect(data.stability.drucker).toEqual(expected['stability']);
      expect(data.fit.method).toBe('linear_least_squares');
      expect(data.fit.datasetSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(data.unverified).toBe(true);
      expect(data.reviewRequired).toBe(true);
      expect(data.basis).toBe('unspecified');
    }
    const mr = fit({ kind: 'hyper_mooney_rivlin', tests: ALL });
    expect(mr.warnings.filter((w) => w.code === 'MATL_HYPERELASTIC_UNSTABLE').length).toBeGreaterThan(0);
    expect(mr.stability.drucker['ET']).toEqual({ tension: 8.86, compression: 0.28 });
  });

  it('reports the Ogden 1972 set RMS against the table (report only)', () => {
    const terms = [
      [0.63, 1.3],
      [0.0012, 5],
      [-0.01, -2],
    ] as const;
    const law = { kind: 'ogden', mu: terms.map(([m, a]) => (m * a) / 2), alpha: terms.map(([, a]) => a), shearModulus: 0.4225 } as const;
    const rms = Object.fromEntries(
      (['UT', 'ET', 'PS'] as const).map((mode) => {
        const r = TRELOAR[mode].map(([lambda, p]) => nominalStress(law, mode, lambda ?? 1) - (p ?? 0));
        return [mode, Math.sqrt(r.reduce((s, x) => s + x * x, 0) / r.length)];
      }),
    );
    expectCase(
      PACK,
      'VC-MATL-08/ogden1972set/rmsVsTreloar',
      Object.fromEntries(Object.entries(rms).map(([mode, value]) => [mode, Number(value.toPrecision(6))])),
    );
  });

  it('returns a model that add_material_model accepts unchanged, with its fit record', () => {
    const data = fit({
      kind: 'hyper_yeoh',
      tests: ALL,
      dataSource: { citation: 'Treloar (1944) as tabulated by Steinmann et al. (2012)' },
      basis: 'typical',
    });
    const base = withMaterial(doc, 'rubber');
    const added = run(base, 'add_material_model', {
      material: 'rubber',
      id: 'yeoh',
      model: data.model,
      validity: data.validity,
      basis: data.basis,
      source: SOURCE,
      fit: data.fit,
    });
    const stored = added.document.materials['rubber']?.materialModels?.[0];
    expect(stored?.fit?.points).toBe(56);
    expect(stored?.reviewedBy).toBeUndefined();
    expect(data.unverified).toBe(true);
    const reasons = (data as unknown as { unverifiedReasons: string[] }).unverifiedReasons;
    expect(reasons).toContain('basis typical');
    expect(reasons).toContain('fit not reviewed');
    expect(reasons).not.toContain('fit without data provenance');
  });

  it('fits polynomial and reduced polynomial laws and honours the relative objective', () => {
    const polynomial = fit({ kind: 'hyper_polynomial', order: 2, tests: ALL });
    expect(Object.keys(polynomial.model['C'] as object)).toEqual(['C10', 'C01', 'C20', 'C11', 'C02']);
    const reduced = fit({ kind: 'hyper_reduced_polynomial', order: 3, tests: ALL, objective: 'relative' });
    expect((reduced.model['Ci0'] as number[]).length).toBe(3);
    expect(reduced.defaults.map((d) => d.name)).not.toContain('objective');
    expect(polynomial.defaults.map((d) => d.name)).toEqual(expect.arrayContaining(['objective', 'basis', 'compressibility']));
    const law = resolveHyper({
      kind: 'hyper_polynomial',
      order: 2,
      C: polynomial.model['C'],
      D: [0, 0],
      stressUnit: 'MPa',
    } as unknown as HyperLaw);
    expect(law?.kind).toBe('invariant');
    expect(polynomialDerivatives([[1, 0, 1]])(3, 3).W).toBe(0);
  });

  it('weights tests and refuses bad data with stable codes', () => {
    const rows = [
      [1, 0],
      [1.5, 0.2],
      [2, 0.3],
      [3, 0.4],
    ];
    const base = { kind: 'hyper_neo_hooke', tests: [{ ...test('UT'), rows }] };
    const codes = (patch: Record<string, unknown>): string => codeOf(doc, 'fit_material_model', { ...base, ...patch });
    expect(codes({})).toBe('accepted');
    expect(codes({ tests: [{ ...test('UT'), rows, weight: 3 }] })).toBe('accepted');
    expect(codes({ tests: [{ ...test('UT'), rows: [[1, 0]] }] })).toBe('MATL_FIT_INSUFFICIENT_DATA');
    expect(codes({ kind: 'hyper_yeoh', tests: [{ ...test('UT'), rows: rows.slice(0, 3) }] })).toBe('MATL_FIT_INSUFFICIENT_DATA');
    expect(codes({ tests: [] })).toBe('MATL_FIT_INSUFFICIENT_DATA');
    expect(codes({ tests: [{ ...test('UT'), mode: 'shear' }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(codes({ tests: [{ ...test('UT'), yMeasure: 'true_stress' }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(codes({ tests: [{ ...test('UT'), units: {} }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(codes({ tests: [{ ...test('UT'), units: { y: 'K' } }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(codes({ tests: [{ ...test('UT'), rows: [[1, 0, 5]] }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(
      codes({
        tests: [
          {
            ...test('UT'),
            rows: [
              [-1, 0],
              [2, 1],
              [3, 2],
              [4, 3],
            ],
          },
        ],
      }),
    ).toBe('MATL_LAW_PARAMS_INVALID');
    expect(codes({ tests: [{ ...test('UT'), weight: -1 }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(codes({ kind: 'hyper_polynomial', order: 4 })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(
      codes({
        kind: 'hyper_mooney_rivlin',
        tests: [
          {
            ...test('UT'),
            rows: [
              [2, 1],
              [2, 1],
              [2, 1],
              [2, 1],
            ],
          },
        ],
      }),
    ).toBe('MATL_FIT_ILL_CONDITIONED');
    const huge = { ...test('UT'), rows: Array.from({ length: 10_001 }, (_, i) => [1 + i / 1000, 0.1]) };
    expect(codes({ tests: [huge] })).toBe('MATL_LAW_PARAMS_INVALID');
  });
});
