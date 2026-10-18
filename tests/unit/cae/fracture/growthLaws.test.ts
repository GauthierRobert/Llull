import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CrackGrowthMaterialModel } from '@core/model/materialDurability';
import { growthRate, newmanClosure, nasgroRate, rateModelOf, type RateModel } from '@cae/fracture/growthLaws';
import { expectedValue } from '../fatigue/support';
import { code, data, materialDoc, relative } from './support';

const PACK = '08-fracture-damage-tolerance';
const expected = expectedValue(PACK, 'VC-FRC-08') as Record<string, number>;
const SI = 'm/cycle|MPa*m^0.5';
const model = (law: CrackGrowthMaterialModel): RateModel => {
  const found = rateModelOf(law);
  if (typeof found === 'string') throw new Error(found);
  return found;
};

describe('growth laws at dK 10 MPa sqrt(m) (VC-FRC-08)', () => {
  it('Paris: C dK^m = 1e-8 m/cycle', () => {
    const paris = model({ kind: 'da_dn_paris', C: 1e-11, m: 3, units: SI, conditions: {} });
    expect(relative(growthRate(paris, 10, 0).rate, expected['paris'] ?? 0)).toBeLessThan(1e-11);
  });

  it('Walker (R 0.5, gamma 0.5) and gamma for negative R', () => {
    const walker = model({
      kind: 'da_dn_walker',
      C: 1e-11,
      m: 3,
      gamma: 0.5,
      gammaNegativeR: 0.8,
      convention: 'dK_over_(1-R)^(1-gamma)',
      units: SI,
      conditions: {},
    });
    expect(relative(growthRate(walker, 10, 0.5).rate, expected['walker_R0.5_g0.5'] ?? 0)).toBeLessThan(1e-11);
    expect(growthRate(walker, 10, -1).rate).toBeCloseTo(1e-11 * (10 / 2 ** 0.2) ** 3, 14);
  });

  it('Forman (R 0.1, Kc 60) and its pole at Kmax = Kc', () => {
    const forman = model({ kind: 'da_dn_forman', C: 1e-11, n: 3, Kc: 60, units: SI, conditions: {} });
    expect(relative(growthRate(forman, 10, 0.1).rate, expected['forman_R0.1'] ?? 0)).toBeLessThan(1e-11);
    expect(growthRate(forman, 54, 0.1).rate).toBe(Number.POSITIVE_INFINITY);
  });

  it('NASGRO with f = 0.1, dKth 2, p = q = 0.25; zero at the threshold, infinite at Kc', () => {
    const nasgro = model({
      kind: 'da_dn_nasgro',
      C: 1e-11,
      n: 3,
      p: 0.25,
      q: 0.25,
      threshold: { dKth: 2 },
      toughness: { Kc: 60 },
      closure: { kind: 'none' },
      units: SI,
      conditions: {},
    });
    if (nasgro.kind !== 'nasgro') throw new Error('nasgro');
    expect(relative(nasgroRate(nasgro, 10, 0.1, 0.1), expected['nasgro_R0.1_f0.1_dKth2_p0.25_q0.25'] ?? 0)).toBeLessThan(1e-11);
    expect(growthRate(nasgro, 1.5, 0.1).rate).toBe(0);
    expect(growthRate(nasgro, 55, 0.1).rate).toBe(Number.POSITIVE_INFINITY);
    expect(growthRate(nasgro, 0, 0.1).rate).toBe(0);
  });

  it('NASGRO closure: Newman function values (grade C), table interpolation and clamping', () => {
    const f = expectedValue(PACK, 'VC-FRC-09') as Record<string, number>;
    expect(relative(newmanClosure(0.1, 2, 0.3), f['R=0.1'] ?? 0)).toBeLessThan(1e-11);
    expect(relative(newmanClosure(0.5, 2, 0.3), f['R=0.5'] ?? 0)).toBeLessThan(1e-11);
    expect(Math.abs(newmanClosure(-1, 2, 0.3) - (f['R=-1.0'] ?? 0))).toBeLessThan(1e-11);
    const tabulated = (kind: 'table' | 'newman'): RateModel =>
      model({
        kind: 'da_dn_nasgro',
        C: 1e-11,
        n: 3,
        p: 0,
        q: 0,
        threshold: { dKth: 0 },
        toughness: { Kc: 1000 },
        closure:
          kind === 'table'
            ? {
                kind: 'table',
                points: [
                  [0, 0.2],
                  [0.5, 0.4],
                ],
              }
            : { kind: 'newman', alpha: 2, smaxOverSigma0: 0.3 },
        units: SI,
        conditions: {},
      });
    const rate = (R: number): number => growthRate(tabulated('table'), 10, R).rate;
    const base = (R: number, fValue: number): number => 1e-11 * (((1 - fValue) / (1 - R)) * 10) ** 3;
    expect(rate(0.25)).toBeCloseTo(base(0.25, 0.3), 14);
    expect(rate(-1)).toBeCloseTo(base(-1, 0.2), 14);
    expect(rate(0.9)).toBeCloseTo(base(0.9, 0.4), 14);
    expect(growthRate(tabulated('newman'), 10, 0.1).rate).toBeCloseTo(base(0.1, f['R=0.1'] ?? 0), 14);
  });

  it('tabulated log-log rates, linear in R, flagged outside the data', () => {
    const table = model({
      kind: 'da_dn_table',
      families: [
        {
          stressRatio: 0,
          points: [
            [5, 1e-9],
            [20, 1e-7],
          ],
        },
        {
          stressRatio: 0.5,
          points: [
            [5, 1e-8],
            [20, 1e-6],
          ],
        },
      ],
      interpolation: 'log_log',
      units: SI,
      conditions: {},
    });
    const mid = growthRate(table, 10, 0);
    expect(mid.rate).toBeCloseTo(1e-9 * 2 ** (Math.log10(1e-7 / 1e-9) / Math.log10(4)), 16);
    expect(mid.extrapolated).toBe(false);
    expect(growthRate(table, 10, 0.25).rate).toBeCloseTo((mid.rate + growthRate(table, 10, 0.5).rate) / 2, 16);
    expect(growthRate(table, 50, 0).extrapolated).toBe(true);
    expect(growthRate(table, 2, 0).extrapolated).toBe(true);
    expect(growthRate(table, 10, 0.9).extrapolated).toBe(true);
  });

  it('Paris threshold and dK range extrapolation flag', () => {
    const paris = model({
      kind: 'da_dn_paris',
      C: 1e-11,
      m: 3,
      dKth: 3,
      units: SI,
      conditions: { dKRange: { min: 4, max: 40, unit: 'MPa*m^0.5' } },
    });
    expect(growthRate(paris, 2, 0)).toEqual({ rate: 0, extrapolated: true });
    expect(growthRate(paris, 10, 0).extrapolated).toBe(false);
    expect(growthRate(paris, 50, 0).extrapolated).toBe(true);
  });

  it('imperial units convert: C = 1e-9 in/cycle per (ksi sqrt(in))^3 gives the SI rate at 10 MPa sqrt(m)', () => {
    const imperial = model({ kind: 'da_dn_paris', C: 1e-9, m: 3, units: 'in/cycle|ksi*in^0.5', conditions: {} });
    const dKksi = 10 / 1.0988434941087546;
    expect(relative(growthRate(imperial, 10, 0).rate, 1e-9 * dKksi ** 3 * 0.0254)).toBeLessThan(1e-12);
    const forman = model({ kind: 'da_dn_forman', C: 1e-9, n: 3, Kc: 50, units: 'in/cycle|ksi*in^0.5', conditions: {} });
    expect(relative(growthRate(forman, 10, 0.1).rate, (1e-9 * dKksi ** 3 * 0.0254) / (0.9 * 50 - dKksi))).toBeLessThan(1e-12);
  });

  it('rejects unknown units and unsupported NASGRO variants', () => {
    expect(rateModelOf({ kind: 'da_dn_paris', C: 1, m: 3, units: 'furlong/fortnight' as never, conditions: {} })).toMatch(/units/);
    const base = { kind: 'da_dn_nasgro', C: 1e-11, n: 3, p: 0.25, q: 0.25, closure: { kind: 'none' }, units: SI, conditions: {} } as const;
    expect(rateModelOf({ ...base, threshold: { dK0: 3 }, toughness: { Kc: 60 } })).toMatch(/dKth/);
    expect(rateModelOf({ ...base, threshold: { dKth: 3 }, toughness: { KIc: 30, Ak: 1, Bk: 1 } })).toMatch(/Kc/);
    expect(rateModelOf({ kind: 'fracture_toughness', state: 'plane_strain' })).toMatch(/toughness/);
    expect(rateModelOf({ kind: 'da_dn_paris', C: 1, m: 3, units: SI, conditions: { dKRange: { min: 1, max: 2, unit: 'mm' } } })).toMatch(
      /dKRange/,
    );
  });
});

describe('crack_growth_rate command', () => {
  const doc = materialDoc();

  it('Paris C 1e-11, m 3 at dK 10 MPa sqrt(m) is 1e-8 m/cycle; ksi sqrt(in) input converts; read-only', () => {
    const result = execute(doc, 'crack_growth_rate', {
      material: 'dt_test',
      growthModelId: 'paris1',
      dK: { value: 10, unit: 'MPa*m^0.5' },
    });
    expect(relative(data(result)['dadNMPerCycle'] as number, expected['paris'] ?? 0)).toBeLessThan(1e-11);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const imperial = execute(doc, 'crack_growth_rate', {
      material: 'dt_test',
      growthModelId: 'paris1',
      dK: { value: 10 / 1.0988434941087546, unit: 'ksi*in^0.5' },
    });
    expect(relative(data(imperial)['dadNMPerCycle'] as number, 1e-8)).toBeLessThan(1e-9);
  });

  it.each([
    ['unknown material', { material: 'nope', growthModelId: 'paris1' }, 'FRC_MODEL_MISSING'],
    ['unknown model', { material: 'dt_test', growthModelId: 'zzz' }, 'FRC_MODEL_MISSING'],
    ['a toughness model', { material: 'dt_test', growthModelId: 'kc1' }, 'FRC_MODEL_MISSING'],
    ['dK not a stress intensity', { material: 'dt_test', growthModelId: 'paris1', dK: { value: 10, unit: 'MPa' } }, 'FRC_PARAMS_INVALID'],
    ['dK <= 0', { material: 'dt_test', growthModelId: 'paris1', dK: { value: 0, unit: 'MPa*m^0.5' } }, 'FRC_PARAMS_INVALID'],
    ['R >= 1', { material: 'dt_test', growthModelId: 'paris1', R: 1 }, 'FRC_PARAMS_INVALID'],
  ])('refuses %s', (_label, params, expectedCode) => {
    const result = execute(doc, 'crack_growth_rate', { dK: { value: 10, unit: 'MPa*m^0.5' }, ...params });
    expect(code(result)).toBe(expectedCode);
    expect(result.document).toBe(doc);
  });

  it('refuses a model with unsupported units', () => {
    const bad = execute(doc, 'add_material_model', {
      material: 'dt_test',
      id: 'nas',
      model: {
        kind: 'da_dn_nasgro',
        C: 1e-11,
        n: 3,
        p: 0.25,
        q: 0.25,
        threshold: { dK0: 3 },
        toughness: { Kc: 60 },
        closure: { kind: 'none' },
        units: SI,
        conditions: {},
      },
      basis: 'company',
      source: { citation: 'test' },
    });
    expect(
      code(execute(bad.document, 'crack_growth_rate', { material: 'dt_test', growthModelId: 'nas', dK: { value: 10, unit: 'MPa*m^0.5' } })),
    ).toBe('FRC_UNITS_MISMATCH');
  });
});
