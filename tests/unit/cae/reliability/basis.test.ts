import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { nonparametricBasis, normalToleranceFactor, noncentralTCdf } from '@cae/reliability/toleranceFactor';
import { code, data } from './support';

/**
 * Published one-sided normal tolerance factors (B-basis: 90 % / 95 %, A-basis: 99 % / 95 %), 4-digit table values as quoted in MIL-HDBK-5J /
 * CMH-17 Vol. 1 (the table values are quoted from memory of those tables: see validation/sources.md, open question 5).
 */
const PUBLISHED: ReadonlyArray<readonly [number, number, number]> = [
  [2, 20.581, 37.094],
  [5, 3.407, 5.741],
  [10, 2.355, 3.981],
  [15, 2.068, 3.52],
  [20, 1.926, 3.295],
  [30, 1.777, 3.064],
  [50, 1.646, 2.862],
  [100, 1.527, 2.684],
];

describe('normal tolerance factor (non-central t)', () => {
  it.each(PUBLISHED)('n = %i reproduces the published B and A factors to 4 digits', (n, kB, kA) => {
    expect(Math.abs(normalToleranceFactor(n, 0.9, 0.95) - kB)).toBeLessThan(6e-4);
    expect(Math.abs(normalToleranceFactor(n, 0.99, 0.95) - kA)).toBeLessThan(6e-4);
  });

  it('matches the generator reference (validation/tolerance_factors.csv) to 1e-6 relative and tends to z_p', () => {
    expect(Math.abs(normalToleranceFactor(10, 0.9, 0.95) / 2.3546401 - 1)).toBeLessThan(1e-6);
    expect(Math.abs(normalToleranceFactor(10, 0.99, 0.95) / 3.9811178 - 1)).toBeLessThan(1e-6);
    expect(Math.abs(normalToleranceFactor(100000, 0.9, 0.95) - 1.2815516)).toBeLessThan(1e-2);
  });

  it('the non-central t cdf is exact for delta = 0 (central t with 1 degree: Cauchy) and returns NaN factor for bad input', () => {
    expect(noncentralTCdf(1, 1, 0)).toBeCloseTo(0.75, 6);
    expect(noncentralTCdf(0, 5, 0)).toBeCloseTo(0.5, 8);
    expect(Number.isNaN(normalToleranceFactor(1, 0.9, 0.95))).toBe(true);
    expect(Number.isNaN(normalToleranceFactor(10, 1, 0.95))).toBe(true);
  });
});

describe('nonparametric basis', () => {
  it('needs n >= 299 for A-basis and n >= 29 for B-basis (CMH-17 / MMPDS lowest-value rule)', () => {
    expect(nonparametricBasis(299, 0.99, 0.95)).toEqual({ rank: 1, minimumN: 299 });
    expect(nonparametricBasis(298, 0.99, 0.95).rank).toBe(0);
    expect(nonparametricBasis(29, 0.9, 0.95)).toEqual({ rank: 1, minimumN: 29 });
    expect(nonparametricBasis(28, 0.9, 0.95).rank).toBe(0);
  });

  it('the rank grows with n and matches the binomial bound: n = 100, B-basis gives rank 5 (P(Bin(100, .1) >= 5) = 0.9763, >= 6: 0.9424)', () => {
    expect(nonparametricBasis(100, 0.9, 0.95).rank).toBe(5);
  });
});

describe('basis_tolerance_factor', () => {
  it('returns k for the B-basis default and for A-basis, deterministic and pure', () => {
    const doc = createEmptyDocument();
    const b = execute(doc, 'basis_tolerance_factor', { n: 10 });
    expect(b.document).toBe(doc);
    expect(b.affected).toEqual([]);
    expect(Math.abs((data(b)['k'] as number) - 2.35464)).toBeLessThan(1e-5);
    expect(data(b)['method']).toBe('non-central t');
    expect(data(b)['reviewRequired']).toBe(true);
    expect(b.summary).toContain('k = 2.3546');
    const a = execute(doc, 'basis_tolerance_factor', { n: 10, coverage: 0.99 });
    expect(Math.abs((data(a)['k'] as number) - 3.98112)).toBeLessThan(1e-5);
  });

  it('nonparametric: rank and minimum n, and says when n is too small', () => {
    const doc = createEmptyDocument();
    const ok = execute(doc, 'basis_tolerance_factor', { n: 300, coverage: 0.99, method: 'nonparametric' });
    expect(data(ok)['rank']).toBeGreaterThanOrEqual(1);
    expect(data(ok)['minimumN']).toBe(299);
    const small = execute(doc, 'basis_tolerance_factor', { n: 10, method: 'nonparametric' });
    expect(data(small)['rank']).toBe(0);
    expect(data(small)['note']).toContain('below the minimum 29');
  });

  it('refuses n below 2, coverage outside (0, 1) and n above the cap, unchanged', () => {
    const doc = createEmptyDocument();
    for (const params of [{ n: 1 }, { n: 10, coverage: 1 }, { n: 10, confidence: 0 }, { n: 1_000_000 }]) {
      const result = execute(doc, 'basis_tolerance_factor', params);
      expect(code(result)).toBe('CMD_INVALID_PARAMS');
      expect(result.document).toBe(doc);
    }
  });
});
