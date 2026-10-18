import { describe, expect, it } from 'vitest';
import type { FatigueMaterialModel } from '@core/model/materialDurability';
import {
  cyclicCurveOf,
  cyclicStrain,
  equivalentAmplitude,
  masingStrainRange,
  neuberStress,
  notchFactor,
  strainLifeReversals,
  stressLife,
  swtLifeReversals,
  toMpa,
  transitionReversals,
} from '@cae/fatigue/lifeMath';
import { expectedValue, relativeError } from './support';

const conditions = { probability: 'mean', control: 'load' } as const;
const basquin = (extra: object = {}): Extract<FatigueMaterialModel, { kind: 'sn_basquin' }> => ({
  kind: 'sn_basquin',
  sigmaF: { value: 1160, unit: 'MPa' },
  b: -0.081,
  conditions,
  ...extra,
});
const strain: Extract<FatigueMaterialModel, { kind: 'en_coffin_manson' }> = {
  kind: 'en_coffin_manson',
  sigmaF: { value: 1160, unit: 'MPa' },
  b: -0.081,
  epsF: 1.1,
  c: -0.65,
  E: { value: 210000, unit: 'MPa' },
  conditions: { probability: 'mean', control: 'strain' },
};
const cyclic = cyclicCurveOf({
  kind: 'cyclic_ramberg_osgood',
  Kprime: { value: 1060, unit: 'MPa' },
  nPrime: 0.14,
  E: { value: 210000, unit: 'MPa' },
});

describe('stress-life', () => {
  it('VC-FAT-10: Basquin 2Nf at 400 MPa equals the closed form (sa/sf)^(1/b)', () => {
    const life = stressLife(basquin(), 400);
    expect(2 * (life?.cycles ?? 0)).toBeCloseTo(expectedValue('07-fatigue', 'VC-FAT-10') as number, 4);
    expect(relativeError(2 * (life?.cycles ?? 0), (400 / 1160) ** (1 / -0.081))).toBeLessThan(1e-14);
  });

  it('VC-FAT-11: power law N = ND (S/SD)^-k', () => {
    const model: FatigueMaterialModel = { kind: 'sn_power_law', k: 5, nD: 1e6, sD: { value: 200, unit: 'MPa' }, conditions };
    expect(relativeError(stressLife(model, 300)?.cycles ?? 0, expectedValue('07-fatigue', 'VC-FAT-11') as number)).toBeLessThan(1e-9);
  });

  it('power law beyond the knee: k2 slope, cut-off gives infinite life', () => {
    const base = { kind: 'sn_power_law', k: 5, nD: 1e6, sD: { value: 200, unit: 'MPa' }, conditions } as const;
    expect(stressLife({ ...base, k2: 10 }, 100)?.cycles).toBeCloseTo(1e6 * 0.5 ** -10, 3);
    expect(stressLife({ ...base, k2: 'cutoff' }, 100)?.cycles).toBe(Number.POSITIVE_INFINITY);
  });

  it('Basquin endurance limit gives infinite life; zero amplitude too; units convert (ksi)', () => {
    expect(stressLife(basquin({ enduranceAmplitude: { value: 200, unit: 'MPa' } }), 150)?.cycles).toBe(Number.POSITIVE_INFINITY);
    expect(stressLife(basquin(), 0)?.cycles).toBe(Number.POSITIVE_INFINITY);
    expect(toMpa({ value: 10, unit: 'ksi' })).toBeCloseTo(68.9476, 3);
    expect(toMpa({ value: 1, unit: 'mm' })).toBeNull();
  });

  it('VC-FAT-61 i: outside the tested life range is flagged extrapolated; inside is not', () => {
    const model = basquin({ conditions: { ...conditions, testedLifeRange: { minCycles: 100, maxCycles: 1e7 } } });
    const low = stressLife(model, 100);
    expect(low?.extrapolated).toBe(true);
    expect(relativeError(2 * (low?.cycles ?? 0), expectedValue('07-fatigue', 'VC-FAT-61') as number)).toBeLessThan(1e-9);
    expect(stressLife(model, 400)?.extrapolated).toBe(false);
  });

  it('tabulated S-N interpolates log-log and flags points outside the table', () => {
    const model: FatigueMaterialModel = {
      kind: 'sn_table',
      families: [
        {
          points: [
            [1e4, 400],
            [1e6, 200],
          ],
          amplitudeUnit: 'MPa',
        },
      ],
      measure: 'amplitude',
      conditions,
    };
    expect(stressLife(model, 282.842712475)?.cycles).toBeCloseTo(1e5, 0);
    expect(stressLife(model, 282.842712475)?.extrapolated).toBe(false);
    expect(stressLife(model, 100)?.extrapolated).toBe(true);
    expect(stressLife({ ...model, families: [] }, 100)).toBeNull();
  });

  it('malformed models give null', () => {
    expect(stressLife(basquin({ b: 0.1 }), 100)).toBeNull();
    expect(stressLife(basquin({ sigmaF: { value: 1, unit: 'mm' } }), 100)).toBeNull();
    expect(stressLife({ kind: 'sn_power_law', k: 5, nD: 1e6, sD: { value: 1, unit: 'mm' }, conditions }, 100)).toBeNull();
  });
});

describe('mean stress (VC-FAT-30)', () => {
  const expected = expectedValue('07-fatigue', 'VC-FAT-30') as Record<string, number>;
  const inputs = { su: 500, sy: 400, sigmaF: 1160, compressiveMean: 'no_benefit' } as const;
  it.each(['goodman', 'gerber', 'soderberg', 'morrow'] as const)('%s', (model) => {
    expect(relativeError(equivalentAmplitude(200, 100, { ...inputs, model }) ?? 0, expected[model] ?? 0)).toBeLessThan(1e-11);
  });
  it('swt and walker (gamma 0.7); walker gamma 0.5 equals swt', () => {
    expect(relativeError(equivalentAmplitude(200, 100, { ...inputs, model: 'swt' }) ?? 0, expected['swt'] ?? 0)).toBeLessThan(1e-11);
    expect(
      relativeError(equivalentAmplitude(200, 100, { ...inputs, model: 'walker', gamma: 0.7 }) ?? 0, expected['walker'] ?? 0),
    ).toBeLessThan(1e-11);
    expect(equivalentAmplitude(200, 100, { ...inputs, model: 'walker', gamma: 0.5 })).toBeCloseTo(
      equivalentAmplitude(200, 100, { ...inputs, model: 'swt' }) ?? 0,
      10,
    );
  });
  it('compressive mean: no benefit unless the formula rule is chosen; smax <= 0 gives zero under SWT', () => {
    expect(equivalentAmplitude(200, -100, { ...inputs, model: 'goodman' })).toBe(200);
    expect(equivalentAmplitude(200, -100, { ...inputs, model: 'goodman', compressiveMean: 'formula' })).toBeCloseTo(200 / 1.2, 10);
    expect(equivalentAmplitude(100, -200, { ...inputs, model: 'swt' })).toBe(0);
  });
  it('none is identity; mean at the strength is a static failure; a missing strength is null; walker without gamma is null', () => {
    expect(equivalentAmplitude(123, 50, { compressiveMean: 'no_benefit', model: 'none' })).toBe(123);
    expect(equivalentAmplitude(100, 500, { ...inputs, model: 'goodman' })).toBe(Number.POSITIVE_INFINITY);
    expect(equivalentAmplitude(100, 50, { compressiveMean: 'no_benefit', model: 'goodman' })).toBeNull();
    expect(equivalentAmplitude(100, 50, { ...inputs, model: 'walker' })).toBeNull();
  });
});

describe('strain-life and notch', () => {
  it('VC-FAT-12 / 13: CMB life at eps_a 0.0075 and the transition life', () => {
    expect(relativeError(strainLifeReversals(strain, 0.0075) ?? 0, expectedValue('07-fatigue', 'VC-FAT-12') as number)).toBeLessThan(1e-9);
    expect(relativeError(transitionReversals(strain) ?? 0, expectedValue('07-fatigue', 'VC-FAT-13') as number)).toBeLessThan(1e-9);
  });

  it('VC-FAT-14: Morrow mean-stress term', () => {
    expect(relativeError(strainLifeReversals(strain, 0.005, 100) ?? 0, expectedValue('07-fatigue', 'VC-FAT-14') as number)).toBeLessThan(
      1e-9,
    );
  });

  it('VC-FAT-20 / 21 / 22 / 24: Kf, Neuber local stress, SWT life, Masing range', () => {
    const kf = notchFactor(2.41, 0.9857);
    expect(relativeError(kf, expectedValue('07-fatigue', 'VC-FAT-20') as number)).toBeLessThan(1e-11);
    if (cyclic === null) throw new Error('cyclic curve');
    const sigma = neuberStress(cyclic, kf * 375);
    expect(relativeError(sigma, expectedValue('07-fatigue', 'VC-FAT-21') as number)).toBeLessThan(1e-9);
    const reversals = swtLifeReversals(strain, sigma, cyclicStrain(cyclic, sigma));
    expect(relativeError((reversals ?? 0) / 2, expectedValue('07-fatigue', 'VC-FAT-22') as number)).toBeLessThan(1e-6);
    expect(relativeError(masingStrainRange(cyclic, 800), expectedValue('07-fatigue', 'VC-FAT-24') as number)).toBeLessThan(1e-11);
  });

  it('VC-FAT-23: notch sensitivity formulas (Peterson, Neuber) stay textbook values', () => {
    const expected = expectedValue('07-fatigue', 'VC-FAT-23') as Record<string, number>;
    expect(1 / (1 + 0.25 / 1)).toBeCloseTo(expected['peterson'] ?? 0, 12);
    expect(1 / (1 + Math.sqrt(0.25 / 1))).toBeCloseTo(expected['neuber'] ?? 0, 10);
  });

  it('degenerate inputs: no stress gives 0, non-positive constants give null, impossible targets give null', () => {
    if (cyclic === null) throw new Error('cyclic curve');
    expect(neuberStress(cyclic, 0)).toBe(0);
    expect(strainLifeReversals({ ...strain, sigmaF: { value: 1, unit: 'mm' } }, 0.005)).toBeNull();
    expect(swtLifeReversals({ ...strain, E: { value: -1, unit: 'MPa' } }, 100, 0.005)).toBeNull();
    expect(transitionReversals({ ...strain, c: -0.081 })).toBeNull();
    expect(
      cyclicCurveOf({ kind: 'cyclic_ramberg_osgood', Kprime: { value: 1060, unit: 'MPa' }, nPrime: 0, E: { value: 210000, unit: 'MPa' } }),
    ).toBeNull();
  });
});
