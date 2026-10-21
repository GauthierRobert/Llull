import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Distribution } from '@cae/reliability/types';
import { cdf, distributionIssue, fromStandardNormal, invCdf, momentsOf } from '@cae/reliability/distributions';
import { equivalentCorrelation } from '@cae/reliability/nataf';
import { cholesky } from '@lib/denseLinalg';
import { normalCdf } from '@lib/specialFunctions';
import { gamma, normalInv, symmetricEigenvalues } from '@cae/reliability/numerics';
import { createPrng } from '@cae/reliability/prng';
import { estimatePf, sampleStats, standardNormalSamples } from '@cae/reliability/sampling';
import { relative } from './support';

describe('normal functions (VC-PRB-09)', () => {
  it('reproduces the beta / Pf table of the validation pack to 1e-10', () => {
    const csv = readFileSync('docs/physics/18-probabilistic-sensitivity/validation/beta_pf_table.csv', 'utf8').trim().split('\n').slice(1);
    expect(csv.length).toBe(10);
    for (const line of csv) {
      const [beta, pf] = line.split(',').map(Number) as [number, number];
      expect(relative(normalCdf(-beta), pf)).toBeLessThan(1e-10);
      expect(Math.abs(normalInv(pf) + beta)).toBeLessThan(1e-9);
    }
  });

  it('matches the spec constants and is symmetric', () => {
    expect(relative(normalCdf(-3), 1.34989803163e-3)).toBeLessThan(1e-10);
    expect(relative(-normalInv(1e-6), 4.75342430882)).toBeLessThan(1e-10);
    expect(normalCdf(0)).toBeCloseTo(0.5, 15);
    expect(normalCdf(1.3) + normalCdf(-1.3)).toBeCloseTo(1, 14);
    expect(normalInv(0.5)).toBeCloseTo(0, 14);
    expect(Number.isNaN(normalInv(0))).toBe(true);
    expect(Number.isNaN(normalInv(1.5))).toBe(true);
  });

  it('inverts across the central and tail branches', () => {
    for (const p of [1e-10, 1e-4, 0.01, 0.03, 0.3, 0.5, 0.8, 0.97, 0.9999])
      expect(relative(normalCdf(normalInv(p)), p)).toBeLessThan(1e-11);
  });
});

describe('linear algebra helpers', () => {
  it('computes Gamma, Cholesky and symmetric eigenvalues', () => {
    expect(gamma(5)).toBeCloseTo(24, 10);
    expect(gamma(0.5)).toBeCloseTo(Math.sqrt(Math.PI), 12);
    expect(
      cholesky([
        [4, 2],
        [2, 3],
      ]),
    ).toEqual([
      [2, 0],
      [1, Math.sqrt(2)],
    ]);
    expect(
      cholesky([
        [1, 2],
        [2, 1],
      ]),
    ).toBeNull();
    const eigenvalues = symmetricEigenvalues([
      [2, 1, 0],
      [1, 2, 0],
      [0, 0, 5],
    ]);
    expect(eigenvalues[0]).toBeCloseTo(1, 12);
    expect(eigenvalues[1]).toBeCloseTo(3, 12);
    expect(eigenvalues[2]).toBeCloseTo(5, 12);
  });
});

describe('distributions', () => {
  const all: Distribution[] = [
    { kind: 'normal', mean: 5, sd: 2 },
    { kind: 'lognormal', mean: 3, sd: 0.9 },
    { kind: 'uniform', min: -2, max: 6 },
    { kind: 'weibull', shape: 2.5, scale: 4 },
    { kind: 'gumbel', location: 1, scale: 0.7 },
  ];

  it('round-trips cdf and invCdf and maps standard normals consistently', () => {
    for (const d of all)
      for (const p of [0.01, 0.2, 0.5, 0.9, 0.995]) {
        expect(cdf(d, invCdf(d, p))).toBeCloseTo(p, 10);
        expect(fromStandardNormal(d, normalInv(p))).toBeCloseTo(invCdf(d, p), 8);
      }
  });

  it('has the textbook moments', () => {
    expect(momentsOf({ kind: 'lognormal', mean: 3, sd: 0.9 })).toEqual({ mean: 3, sd: 0.9 });
    expect(momentsOf({ kind: 'uniform', min: 0, max: 12 }).sd).toBeCloseTo(Math.sqrt(12), 12);
    const weibull = momentsOf({ kind: 'weibull', shape: 2, scale: 1 });
    expect(weibull.mean).toBeCloseTo(Math.sqrt(Math.PI) / 2, 10);
    expect(weibull.sd).toBeCloseTo(Math.sqrt(1 - Math.PI / 4), 10);
    const gumbel = momentsOf({ kind: 'gumbel', location: 0, scale: 1 });
    expect(gumbel.mean).toBeCloseTo(0.5772156649, 10);
    expect(gumbel.sd).toBeCloseTo(Math.PI / Math.sqrt(6), 12);
    const lognormalMean = invCdf({ kind: 'lognormal', mean: 3, sd: 0.9 }, 0.5);
    expect(lognormalMean).toBeLessThan(3);
  });

  it('flags invalid parameters', () => {
    expect(distributionIssue({ kind: 'normal', mean: 1, sd: 0 })).toMatch(/sd/);
    expect(distributionIssue({ kind: 'lognormal', mean: -1, sd: 1 })).toMatch(/lognormal/);
    expect(distributionIssue({ kind: 'uniform', min: 2, max: 2 })).toMatch(/min < max/);
    expect(distributionIssue({ kind: 'weibull', shape: 0, scale: 1 })).toMatch(/weibull/);
    expect(distributionIssue({ kind: 'gumbel', location: 0, scale: -1 })).toMatch(/gumbel/);
    expect(distributionIssue({ kind: 'normal', mean: Number.NaN, sd: 1 })).toMatch(/finite/);
    for (const d of all) expect(distributionIssue(d)).toBeNull();
  });

  it('cdf is clamped outside the support', () => {
    expect(cdf({ kind: 'lognormal', mean: 3, sd: 1 }, -1)).toBe(0);
    expect(cdf({ kind: 'weibull', shape: 2, scale: 1 }, -1)).toBe(0);
    expect(cdf({ kind: 'uniform', min: 0, max: 1 }, 5)).toBe(1);
  });
});

describe('Nataf equivalent correlation', () => {
  it('equals the closed form ln(1 + rho dA dB) / (zA zB) for two lognormals', () => {
    const a: Distribution = { kind: 'lognormal', mean: 300, sd: 30 };
    const b: Distribution = { kind: 'lognormal', mean: 200, sd: 40 };
    const zeta = (d: { mean: number; sd: number }): number => Math.sqrt(Math.log(1 + (d.sd / d.mean) ** 2));
    const exact = Math.log(1 + 0.5 * 0.1 * 0.2) / (zeta(a) * zeta(b));
    expect(Math.abs((equivalentCorrelation(a, b, 0.5) ?? 99) - exact)).toBeLessThan(1e-6);
  });

  it('is the identity for normals and zero for zero, and refuses unattainable values', () => {
    const n: Distribution = { kind: 'normal', mean: 0, sd: 1 };
    expect(equivalentCorrelation(n, n, 0.3)).toBe(0.3);
    expect(equivalentCorrelation({ kind: 'lognormal', mean: 1, sd: 1 }, n, 0)).toBe(0);
    expect(equivalentCorrelation({ kind: 'lognormal', mean: 1, sd: 1 }, n, 0.99)).toBeNull();
  });
});

describe('seeded sampling', () => {
  it('prng is deterministic, in (0, 1) and standard normal in moments', () => {
    const a = createPrng(42);
    const b = createPrng(42);
    const draws = Array.from({ length: 5 }, () => a.uniform());
    expect(draws).toEqual(Array.from({ length: 5 }, () => b.uniform()));
    expect(draws.every((u) => u > 0 && u < 1)).toBe(true);
    expect(createPrng(43).uniform()).not.toBe(draws[0]);
    expect(createPrng(0).uniform()).toBeGreaterThan(0);
    const normals = createPrng(7);
    const values = Array.from({ length: 20000 }, () => normals.normal());
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan((5 * 1) / Math.sqrt(20000));
    expect(Math.abs(variance - 1)).toBeLessThan((5 * Math.SQRT2) / Math.sqrt(20000));
  });

  it('centred LHS puts exactly one point in every stratum of every variable with marginal mean 0.5 (VC-PRB-07)', () => {
    const n = 10;
    const u = standardNormalSamples('lhs_centred', n, 2, 123);
    for (let d = 0; d < 2; d += 1) {
      const p = Array.from({ length: n }, (_, i) => normalCdf(u[i * 2 + d] ?? 0));
      expect(p.map((value) => Math.floor(value * n)).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(Math.abs(p.reduce((s, v) => s + v, 0) / n - 0.5)).toBeLessThan(1e-12);
    }
  });

  it('random LHS keeps one point per stratum and mc differs from lhs', () => {
    const n = 50;
    const u = standardNormalSamples('lhs', n, 1, 9);
    expect(new Set(Array.from(u, (value) => Math.floor(normalCdf(value) * n))).size).toBe(n);
    expect(standardNormalSamples('mc', n, 1, 9)).not.toEqual(u);
  });
});

describe('statistics', () => {
  it('summarises a sample: moments, quantiles, histogram counts', () => {
    const stats = sampleStats(Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(stats.mean).toBe(5.5);
    expect(stats.sd).toBeCloseTo(Math.sqrt(55 / 6), 12);
    expect(stats.quantiles['0.5']).toBe(5.5);
    expect(stats.histogram.counts.reduce((s, c) => s + c, 0)).toBe(10);
    expect(sampleStats(Float64Array.from([2])).sd).toBe(0);
  });

  it('estimates Pf with a Wilson interval and the rule of three for zero failures', () => {
    const some = estimatePf(20, 1000);
    expect(some.pf).toBe(0.02);
    expect(some.wilson95[0]).toBeLessThan(0.02);
    expect(some.wilson95[1]).toBeGreaterThan(0.02);
    expect(some.belowResolution).toBe(false);
    const none = estimatePf(0, 1000);
    expect(none.belowResolution).toBe(true);
    expect(none.upperBound).toBe(0.003);
    expect(none.betaEquivalent).toBeNull();
  });
});
