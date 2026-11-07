/** PHY-00 FR-VNV-19 / VC-VNV-22: least-squares observed order (f = f0 + alpha h^p, Eca & Hoekstra model) against exact laws and an independent scipy fit. */
import { describe, expect, it } from 'vitest';
import { expectCase } from './benchmarkCases';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
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

describe('check_convergence method least_squares: statuses and findings', () => {
  const doc = createEmptyDocument();
  const run = (
    values: readonly number[],
    extra: Record<string, unknown> = {},
  ): { status: string; codes: string[]; data: Record<string, unknown> } => {
    const samples = values.map((value, index) => ({ h: 0.1 * 2 ** index, value }));
    const result = execute(doc, 'check_convergence', { quantity: 'q', unit: '1', samples, method: 'least_squares', ...extra });
    expect(result.document).toBe(doc);
    const data = result.data as { status: string; codes: string[] } & Record<string, unknown>;
    return { status: data.status, codes: data.codes, data };
  };

  it('classifies before fitting: oscillating, diverging and exactly converged sets carry no fit or extrapolation', () => {
    const oscillating = run([1, 1.1, 1.0, 1.1]);
    expect([oscillating.status, oscillating.codes]).toEqual(['oscillatory', ['VNV_OSCILLATORY']]);
    const diverging = run([1, 1.5, 1.7, 1.75]);
    expect([diverging.status, diverging.codes]).toEqual(['divergent', ['VNV_DIVERGENT']]);
    const exact = run([2, 2, 2, 2]);
    expect([exact.status, exact.codes]).toEqual(['converged_exactly', []]);
    for (const outcome of [oscillating, diverging, exact]) expect(outcome.data['extrapolated']).toBeUndefined();
  });

  it('an order outside [0.05, 8] is VNV_LSQ_NO_FIT (not divergent, no extrapolation): exact h^8 data and slowly converging data', () => {
    for (const values of [[1, 2, 4, 8].map((h) => 10 + 0.001 * h ** 8), [1, 2, 4, 8].map((h) => 10 + h ** 0.01), [1, 1.1, 1.3, 1.31]]) {
      const samples = values.map((value, index) => ({ h: 2 ** index, value }));
      const result = execute(doc, 'check_convergence', { quantity: 'q', unit: '1', samples, method: 'least_squares' });
      const data = result.data as {
        status: string;
        codes: string[];
        p?: number;
        extrapolated?: number;
        findings: { remediation: string }[];
      };
      expect(data.status).toBe('no_fit');
      expect(data.codes, JSON.stringify(values)).toEqual(['VNV_LSQ_NO_FIT']);
      expect(data.codes).not.toContain('VNV_DIVERGENT');
      expect(data.p).toBeUndefined();
      expect(data.extrapolated).toBeUndefined();
      expect(data.findings[0]?.remediation).toBe('observed order outside [0.05, 8]: add levels, or use 3 levels (Celik triplet)');
    }
  });

  it('data whose differences shrink toward the coarse grids is classified divergent by its triplets (never reaches the fit)', () => {
    const samples = [10, 10.02, 10.03, 10.036].map((value, index) => ({ h: 2 ** index, value }));
    const data = execute(doc, 'check_convergence', { quantity: 'q', unit: '1', samples, method: 'least_squares' }).data as {
      status: string;
    };
    expect(data.status).toBe('divergent');
  });

  it('4 levels leave 1 degree of freedom: VNV_LSQ_FEW_DOF warns, 5 levels do not', () => {
    const law = (n: number): number[] => Array.from({ length: n }, (_, k) => 10 + 0.5 * (0.1 * 2 ** k) ** 2);
    expect(run(law(4)).codes).toContain('VNV_LSQ_FEW_DOF');
    expect(run(law(5)).codes).not.toContain('VNV_LSQ_FEW_DOF');
  });

  it('judges the owner target against the fit uncertainty, flags a formal-order mismatch and a finest value of 0', () => {
    const law = [0, 1, 2, 3].map((k) => 10 + 0.5 * (0.1 * 2 ** k) ** 2);
    const tight = run(law, { gciTarget: 1e-9, formalOrder: 4 });
    expect(tight.codes).toEqual(expect.arrayContaining(['VNV_GCI_ABOVE_TARGET', 'VNV_ORDER_MISMATCH']));
    expect(tight.data['requiredSpacing']).toBeUndefined();
    const zero = run([0, 0.3, 1.2, 4.8]);
    expect(zero.codes).toContain('VNV_RELATIVE_UNDEFINED');
    expect(zero.data['gciAbs']).toBeGreaterThan(0);
  });
});
