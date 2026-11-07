/** PHY-00 FR-VNV-19 / VC-VNV-22: least-squares observed order (f = f0 + alpha h^p, Eca & Hoekstra model) against exact laws and an independent scipy fit. */
import { describe, expect, it } from 'vitest';
import { expectCase } from './benchmarkCases';
import { leastSquaresOrder, leastSquaresUncertainty, type LeastSquaresFit } from '@lib/convergence';

const law = (f0: number, alpha: number, p: number, h: readonly number[]): { h: number; value: number }[] =>
  h.map((value) => ({ h: value, value: f0 + alpha * value ** p }));

const fitOf = (result: ReturnType<typeof leastSquaresOrder>): LeastSquaresFit => {
  if (!result.converged) throw new Error(result.reason);
  return result;
};

describe('leastSquaresOrder', () => {
  it('recovers p, f0 and alpha of an exact law to 1e-9 at 4, 5 and 6 levels (VC-VNV-22)', () => {
    for (const levels of [4, 5, 6]) {
      const h = Array.from({ length: levels }, (_, k) => 0.1 * 2 ** k);
      const fit = fitOf(leastSquaresOrder(law(10, 0.5, 1.5, h)));
      expect(fit.p).toBeCloseTo(1.5, 9);
      expect(Math.abs(fit.p - 1.5)).toBeLessThan(1e-9);
      expect(Math.abs(fit.f0 - 10)).toBeLessThan(1e-9);
      expect(Math.abs(fit.alpha - 0.5)).toBeLessThan(1e-9);
      expect(fit.rss).toBeLessThan(1e-18);
      expect(fit.degreesOfFreedom).toBe(levels - 3);
    }
  });

  it('the spec example f = 10 + 0.5 h^2 at h = 0.1, 0.2, 0.4, 0.8 gives p = 2, f0 = 10', () => {
    const fit = fitOf(leastSquaresOrder(law(10, 0.5, 2, [0.1, 0.2, 0.4, 0.8])));
    expect(Math.abs(fit.p - 2)).toBeLessThan(1e-9);
    expect(Math.abs(fit.f0 - 10)).toBeLessThan(1e-9);
    expectCase('00-vv-harness', 'VC-VNV-22.a', fit.p);
    expectCase('00-vv-harness', 'VC-VNV-22.b', fit.f0);
  });

  it('fits noisy data to the independent scipy least_squares solution (hand-checked) and reports the standard errors', () => {
    const h = [0.1, 0.2, 0.4, 0.8, 1.6];
    const values = [10.016211388300842, 10.044421359549997, 10.126991106406736, 10.357370876399965, 11.01212885125388];
    const fit = fitOf(leastSquaresOrder(h.map((value, i) => ({ h: value, value: values[i] as number }))));
    expect(fit.p).toBeCloseTo(1.501927651893835, 9);
    expect(fit.f0).toBeCloseTo(10.000351022564619, 9);
    expect(fit.alpha).toBeCloseTo(0.49945836789352477, 9);
    expect(fit.rss).toBeCloseTo(5.378924302169941e-7, 15);
    expect(fit.standardDeviation).toBeCloseTo(0.0005186002459587703, 12);
    expect(fit.residualRms).toBeCloseTo(0.0003279915944706492, 12);
    expectCase('00-vv-harness', 'VC-VNV-22.c', fit.p);
    expectCase('00-vv-harness', 'VC-VNV-22.d', fit.standardError?.p ?? Number.NaN);
    expect(fit.standardError?.p).toBeCloseTo(0.0027738747527433056, 8);
    expect(fit.standardError?.f0).toBeCloseTo(0.0004887190041887157, 8);
    expect(fit.standardError?.alpha).toBeCloseTo(0.0008304914965280331, 8);
  });

  it('weights move the fit: an up-weighted finest sample is honoured more than with equal weights', () => {
    const h = [0.1, 0.2, 0.4, 0.8];
    const samples = law(10, 0.5, 2, h).map((sample, i) => ({ ...sample, value: sample.value + (i === 0 ? 0.01 : 0) }));
    const equal = fitOf(leastSquaresOrder(samples));
    const heavy = fitOf(leastSquaresOrder(samples, [100, 1, 1, 1]));
    const misfit = (fit: LeastSquaresFit): number =>
      Math.abs((samples[0] as { value: number }).value - (fit.f0 + fit.alpha * 0.1 ** fit.p));
    expect(misfit(heavy)).toBeLessThan(misfit(equal));
  });

  it('refuses what it cannot fit: fewer than 4 samples, bad inputs, bad weights, a plateau', () => {
    expect(leastSquaresOrder(law(1, 1, 2, [0.1, 0.2, 0.4]))).toEqual({ converged: false, reason: 'at least 4 samples are needed' });
    expect(leastSquaresOrder([...law(1, 1, 2, [0.1, 0.2, 0.4]), { h: 0, value: 1 }]).converged).toBe(false);
    expect(leastSquaresOrder([...law(1, 1, 2, [0.1, 0.2, 0.4]), { h: 0.8, value: Number.NaN }]).converged).toBe(false);
    expect(leastSquaresOrder(law(1, 1, 2, [0.1, 0.2, 0.4, 0.8]), [1, 1, 1]).converged).toBe(false);
    expect(leastSquaresOrder(law(1, 1, 2, [0.1, 0.2, 0.4, 0.8]), [1, 1, 1, -1]).converged).toBe(false);
    const flat = leastSquaresOrder([0.1, 0.2, 0.4, 0.8].map((h) => ({ h, value: 3 })));
    expect(flat.converged).toBe(false);
  });

  it('is pure: the samples are not changed', () => {
    const samples = law(10, 0.5, 1.5, [0.1, 0.2, 0.4, 0.8]);
    const before = JSON.stringify(samples);
    leastSquaresOrder(samples);
    expect(JSON.stringify(samples)).toBe(before);
  });
});

describe('leastSquaresUncertainty', () => {
  it('is Fs times the extrapolation distance plus the standard deviation of the fit, relative to the finest value', () => {
    const fit = fitOf(leastSquaresOrder(law(10, 0.5, 1.5, [0.1, 0.2, 0.4, 0.8])));
    const finest = { h: 0.1, value: 10 + 0.5 * 0.1 ** 1.5 };
    const u = leastSquaresUncertainty(fit, finest, 1.25);
    expect(u.absolute).toBeCloseTo(1.25 * 0.5 * 0.1 ** 1.5, 9);
    expect(u.relative).toBeCloseTo(u.absolute / finest.value, 12);
    expect(leastSquaresUncertainty(fit, { h: 0.1, value: 0 }, 1.25).relative).toBeUndefined();
  });
});
