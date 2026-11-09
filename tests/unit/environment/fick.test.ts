import { describe, expect, it } from 'vitest';
import { contentAt, effectiveThickness, equilibriumContent, fractionalUptake, logSpaced, timeToFraction } from '@cae/environment/fick';
import { equivalentTemperatures, proportional } from '@cae/environment/hygro';
import { EROSION_REFERENCES, massLossG, recessionCm } from '@cae/environment/atomicOxygen';
import { LIMIT_GUARD, meetsLimit } from '@cae/environment/profiles';
import { close, pinned, pinnedTau } from './fixtures';

describe('Fick plane sheet (VC-ENV-01..04, 16; Crank series, Shen & Springer 1976)', () => {
  it('inverts G to the pinned dimensionless times (VC-ENV-01)', () => {
    expect(close(timeToFraction(0.5) ?? NaN, pinnedTau['G50'] ?? NaN)).toBe(true);
    expect(close(timeToFraction(0.9) ?? NaN, pinnedTau['G90'] ?? NaN)).toBe(true);
    expect(close(timeToFraction(0.99) ?? NaN, pinnedTau['G99'] ?? NaN)).toBe(true);
  });

  it('matches the pinned series values G(tau) (VC-ENV-02)', () => {
    const values = pinned('VC-ENV-02') as Record<string, number>;
    for (const [tau, g] of Object.entries(values)) expect(close(fractionalUptake(Number(tau)), g)).toBe(true);
  });

  it('short-time form G = 4 sqrt(tau/pi) agrees with the series (VC-ENV-03)', () => {
    const ratios = pinned('VC-ENV-03') as Record<string, number>;
    for (const [tau, ratio] of Object.entries(ratios)) {
      const short = (4 / Math.sqrt(Math.PI)) * Math.sqrt(Number(tau));
      expect(Math.abs(fractionalUptake(Number(tau)) / short - ratio)).toBeLessThan(1e-6);
    }
    const below = 0.9999e-4;
    const above = 1e-4;
    expect(Math.abs(fractionalUptake(above) / fractionalUptake(below) - Math.sqrt(above / below))).toBeLessThan(1e-6);
  });

  it('is zero at tau <= 0, monotonic and saturates at 1', () => {
    expect(fractionalUptake(0)).toBe(0);
    expect(fractionalUptake(-1)).toBe(0);
    expect(fractionalUptake(1e3)).toBe(1);
    expect(fractionalUptake(0.1)).toBeGreaterThan(fractionalUptake(0.05));
  });

  it('refuses fractions outside (0, 1) and round-trips G through its inverse', () => {
    for (const g of [0, 1, -0.5, 1.5, Number.NaN]) expect(timeToFraction(g)).toBeNull();
    expect(timeToFraction(1 - 1e-17)).toBeNull();
    for (const g of [1e-6, 0.001, 0.02, 0.0225, 0.0226, 0.3, 0.999999])
      expect(close(fractionalUptake(timeToFraction(g) ?? NaN), g, 1e-9)).toBe(true);
  });

  it('reproduces the synthetic plate: h 2 mm, D 1e-6 mm^2/s, M 1.5 %, 7 d (VC-ENV-04)', () => {
    const wanted = pinned('VC-ENV-04') as { tau: number; moisturePercent: number; t50Days: number };
    const tau = (1e-12 * 7 * 86400) / (2e-3 * 2e-3);
    expect(close(tau, wanted.tau)).toBe(true);
    expect(close(contentAt(0, 1.5, fractionalUptake(tau)), wanted.moisturePercent)).toBe(true);
    expect(close(((timeToFraction(0.5) ?? NaN) * 4e-6) / 1e-12 / 86400, wanted.t50Days)).toBe(true);
  });

  it('one sealed face equals both faces of a plate twice as thick (VC-ENV-16)', () => {
    const wanted = pinned('VC-ENV-16') as { tauEquivalent: number; moisturePercent: number };
    expect(effectiveThickness(2e-3, 'one')).toBe(4e-3);
    expect(effectiveThickness(2e-3, 'both')).toBe(2e-3);
    const tau = (1e-12 * 7 * 86400) / effectiveThickness(2e-3, 'one') ** 2;
    expect(close(tau, wanted.tauEquivalent)).toBe(true);
    expect(close(contentAt(0, 1.5, fractionalUptake(tau)), wanted.moisturePercent)).toBe(true);
  });

  it('equilibrium content M = a RH^b and the desorption endpoints', () => {
    expect(equilibriumContent(0.02, 1.5, 50)).toBeCloseTo(0.02 * 50 ** 1.5, 12);
    expect(equilibriumContent(0.1, 1, 0)).toBe(0);
    expect(contentAt(1.2, 0, 0)).toBe(1.2);
    expect(contentAt(1.2, 0, 1)).toBe(0);
  });

  it('log-spaced samples include both ends', () => {
    const samples = logSpaced(1, 1000, 4);
    expect(samples[0]).toBe(1);
    expect(samples[3]).toBe(1000);
    expect(samples[1]).toBeCloseTo(10, 9);
  });
});

describe('hygroscopic strain (VC-ENV-05, 13)', () => {
  it('beta dM and the equivalent temperature', () => {
    const wanted = pinned('VC-ENV-05') as { strain: number; equivalentDeltaTK: number };
    const strain = 0.1 * 0.0122660470969;
    expect(close(strain, wanted.strain)).toBe(true);
    const temperatures = equivalentTemperatures([strain], [30e-6]);
    expect(close(temperatures?.[0] ?? NaN, wanted.equivalentDeltaTK)).toBe(true);
  });

  it('proportional directions are one equivalent temperature, others are not', () => {
    expect(proportional([40, 40 * (1 + 1e-12)])).toBe(true);
    expect(proportional([40, 41])).toBe(false);
    expect(proportional([])).toBe(false);
    expect(proportional([0, 0])).toBe(true);
    expect(equivalentTemperatures([1e-3], [0])).toBeNull();
    expect(equivalentTemperatures([1e-3, 2e-3], [1e-5])).toBeNull();
  });
});

describe('atomic oxygen (VC-ENV-08..10)', () => {
  it('recession and mass loss', () => {
    const kapton = EROSION_REFERENCES['kapton_h']?.erosionYieldCm3PerAtom ?? NaN;
    expect(kapton).toBe(3.0e-24);
    expect(close(recessionCm(kapton, 1e21) * 1e4, pinned('VC-ENV-08') as number)).toBe(true);
    expect(close(recessionCm(kapton, 8.43e21) * 1e4, pinned('VC-ENV-09') as number)).toBe(true);
    expect(close(massLossG(1.0, 10, kapton, 1e21), pinned('VC-ENV-10') as number)).toBe(true);
  });
});

describe('limit comparison (TR-ENV-02)', () => {
  it('strict < fails at the limit, <= passes; the guard absorbs rounding', () => {
    expect(meetsLimit(1.0, { quantity: 'TML', op: '<=', value: 1.0, unit: '%' })).toBe(true);
    expect(meetsLimit(1.0, { quantity: 'RML', op: '<', value: 1.0, unit: '%' })).toBe(false);
    expect(meetsLimit(1.0 + LIMIT_GUARD / 10, { quantity: 'TML', op: '<=', value: 1.0, unit: '%' })).toBe(true);
    expect(meetsLimit(1.0 - LIMIT_GUARD / 10, { quantity: 'RML', op: '<', value: 1.0, unit: '%' })).toBe(false);
    expect(meetsLimit(1.000001, { quantity: 'TML', op: '<=', value: 1.0, unit: '%' })).toBe(false);
  });
});
