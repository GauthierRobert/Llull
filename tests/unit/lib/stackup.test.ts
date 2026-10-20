/** 03 GDT M5: stack-up mathematics against docs/aerospace/03-gdt-mbd-pmi/validation/stackup_reference.json (VC-GDT-30..34), PRNG, erfc. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { erfc, normalCdf } from '@lib/erfc';
import { createRandomStream } from '@lib/prng';
import {
  contributions,
  exactCorners,
  exactProbabilities,
  halfOf,
  meanOf,
  monteCarlo,
  probabilityAcceptance,
  rssHalf,
  sigmaOf,
  stackSigma,
  uniformSumCdf,
  worstCaseHalf,
  type StackContributor,
} from '@lib/stackup';
import { compileStackExpression, parseStackExpression, stackGradient } from '@lib/stackExpression';

interface Reference {
  readonly id: string;
  readonly expression: string;
  readonly contributors: ReadonlyArray<{
    name: string;
    nominal: number;
    lower: number;
    upper: number;
    sensitivity: number;
    distribution?: 'normal' | 'uniform';
  }>;
  readonly analytic: {
    yMean: number;
    worstCase: { halfTolerance: number; min: number; max: number };
    worstCaseExactCorners: { min: number; max: number };
    rss: { halfTolerance: number };
    sigma: number;
    lowerSpecLimit?: number;
    pBelowLowerLimit?: number;
  };
  readonly monteCarlo: {
    seed: number;
    samples: number;
    mean: number;
    std: number;
    acceptance: { meanTolerance: number; stdTolerance: number };
  };
}
interface FastenerReference {
  readonly id: string;
}

const reference = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../docs/aerospace/03-gdt-mbd-pmi/validation/stackup_reference.json'), 'utf8'),
) as { stackups: Reference[]; fasteners: FastenerReference[] };

const stack = (ref: Reference): StackContributor[] => ref.contributors.map((c) => ({ ...c, distribution: c.distribution ?? 'normal' }));
const byId = (id: string): Reference => reference.stackups.find((s) => s.id === id) as Reference;

describe('erfc / normalCdf', () => {
  it('matches known values to 1e-12 relative, tails included', () => {
    expect(erfc(0)).toBe(1);
    expect(erfc(1)).toBeCloseTo(0.15729920705028513, 14);
    expect(erfc(2)).toBeCloseTo(0.004677734981047266, 15);
    expect(Math.abs(erfc(3) / 2.209049699858544e-5 - 1)).toBeLessThan(1e-12);
    expect(Math.abs(erfc(5) / 1.5374597944280349e-12 - 1)).toBeLessThan(1e-12);
    expect(Math.abs(erfc(2.5) / 4.069520174449589e-4 - 1)).toBeLessThan(1e-12);
    expect(erfc(-1)).toBeCloseTo(2 - 0.15729920705028513, 14);
    expect(normalCdf(0)).toBe(0.5);
    expect(Math.abs(normalCdf(-3) / 0.0013498980316300946 - 1)).toBeLessThan(1e-12);
  });
});

describe('createRandomStream', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const [a, b, c] = [createRandomStream(7), createRandomStream(7), createRandomStream(8)];
    const first = Array.from({ length: 5 }, () => a.uniform());
    expect(Array.from({ length: 5 }, () => b.uniform())).toEqual(first);
    expect(Array.from({ length: 5 }, () => c.uniform())).not.toEqual(first);
    expect(createRandomStream(0).uniform()).toBeGreaterThan(0);
  });

  it('is uniform (chi-square over 20 bins of 1e5 draws) and keeps the Box-Muller spare', () => {
    const stream = createRandomStream(20261015);
    const bins = new Array<number>(20).fill(0);
    for (let i = 0; i < 100000; i++) {
      const u = stream.uniform();
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
      bins[Math.floor(u * 20)]! += 1;
    }
    const chi2 = bins.reduce((sum, count) => sum + (count - 5000) ** 2 / 5000, 0);
    expect(chi2).toBeLessThan(43.8); // p > 1e-3 for 19 degrees of freedom
    const normals = Array.from({ length: 20000 }, () => stream.normal());
    const mean = normals.reduce((s, x) => s + x, 0) / normals.length;
    const variance = normals.reduce((s, x) => s + (x - mean) ** 2, 0) / normals.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(variance - 1)).toBeLessThan(0.06);
  });
});

describe('closed forms against stackup_reference.json (VC-GDT-30..34)', () => {
  for (const id of ['SU-01', 'SU-02', 'SU-03', 'SU-04']) {
    it(`${id}: worst case, RSS, sigma, corners and exact probability`, () => {
      const ref = byId(id);
      const items = stack(ref);
      const yMean = items.reduce((sum, c) => sum + c.sensitivity * meanOf(c), 0);
      expect(yMean).toBeCloseTo(ref.analytic.yMean, 9);
      expect(worstCaseHalf(items)).toBeCloseTo(ref.analytic.worstCase.halfTolerance, 9);
      expect(rssHalf(items)).toBeCloseTo(ref.analytic.rss.halfTolerance, 9);
      expect(stackSigma(items, 3)).toBeCloseTo(ref.analytic.sigma, 9);
      const linear = (v: readonly number[]): number =>
        items.reduce((sum, c, k) => sum + c.sensitivity * ((v[k] as number) - meanOf(c)), 0) + yMean;
      const corners = exactCorners(items, linear);
      expect(corners?.min).toBeCloseTo(ref.analytic.worstCase.min, 9);
      expect(corners?.max).toBeCloseTo(ref.analytic.worstCase.max, 9);
      const probability = exactProbabilities(items, yMean, 3, ref.analytic.lowerSpecLimit, undefined);
      const expected = ref.analytic.pBelowLowerLimit as number;
      expect(Math.abs((probability?.pBelow as number) - expected)).toBeLessThan(1e-12);
    });
  }

  it('SU-02 exact uniform probability is 29/2400', () => {
    const items = stack(byId('SU-02'));
    const p = exactProbabilities(items, 0.15, 3, 0, undefined);
    expect(p?.pBelow).toBeCloseTo(29 / 2400, 12);
    expect(p?.method).toContain('Irwin-Hall');
  });

  it('SU-05: non-linear stack, exact autodiff sensitivities, linear WC and exact corners', () => {
    const ref = byId('SU-05');
    const parsed = parseStackExpression(ref.expression.split('=')[1]!.trim(), ['L', 'theta_deg']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const f = compileStackExpression(parsed.tree);
    const items = stack(ref);
    const { value, gradient } = stackGradient(parsed.tree, items.map(meanOf));
    expect(value).toBeCloseTo(50, 9);
    expect(gradient[0]).toBeCloseTo(0.5, 12);
    expect(gradient[1]).toBeCloseTo((100 * Math.cos(Math.PI / 6) * Math.PI) / 180, 12);
    const linear = items.map((c, i) => ({ ...c, sensitivity: gradient[i] as number }));
    expect(worstCaseHalf(linear)).toBeCloseTo(ref.analytic.worstCase.halfTolerance, 9);
    expect(rssHalf(linear)).toBeCloseTo(ref.analytic.rss.halfTolerance, 9);
    expect(stackSigma(linear, 3)).toBeCloseTo(ref.analytic.sigma, 9);
    const corners = exactCorners(items, f);
    expect(corners?.min).toBeCloseTo(ref.analytic.worstCaseExactCorners.min, 9);
    expect(corners?.max).toBeCloseTo(ref.analytic.worstCaseExactCorners.max, 9);
  });

  it('refuses corners above 16 contributors and for an empty stack', () => {
    const many = Array.from(
      { length: 17 },
      (_, i): StackContributor => ({ name: `c${i}`, nominal: 1, lower: 0, upper: 0, sensitivity: 1, distribution: 'normal' }),
    );
    expect(exactCorners(many, () => 0)).toBeNull();
    expect(exactCorners([], () => 0)).toBeNull();
  });
});

describe('monteCarlo', () => {
  for (const id of ['SU-01', 'SU-02', 'SU-04']) {
    it(`${id}: deterministic per seed and inside the 5-sigma acceptance bounds`, () => {
      const ref = byId(id);
      const items = stack(ref);
      const f = (values: readonly number[]): number =>
        items.reduce((sum, c, i) => sum + c.sensitivity * ((values[i] as number) - meanOf(c)), 0) + ref.analytic.yMean;
      const options = { seed: ref.monteCarlo.seed, samples: 200000, sigmaPerHalfTolerance: 3, lower: 0, sigma: ref.analytic.sigma };
      const run = monteCarlo(items, f, options);
      expect(monteCarlo(items, f, options)).toEqual(run);
      expect(Math.abs(run.mean - ref.analytic.yMean)).toBeLessThan(run.acceptance.mean);
      expect(Math.abs(run.std - ref.analytic.sigma)).toBeLessThan(run.acceptance.std);
      const p = ref.analytic.pBelowLowerLimit as number;
      expect(Math.abs((run.pBelow as number) - p)).toBeLessThan(probabilityAcceptance(p, 200000));
    });
  }

  it('reports pAbove and a zero std for one sample', () => {
    const items = stack(byId('SU-03'));
    const run = monteCarlo(items, () => 1, { seed: 1, samples: 1, sigmaPerHalfTolerance: 3, upper: 0.5, sigma: 1 });
    expect(run.std).toBe(0);
    expect(run.pAbove).toBe(1);
    expect(run.pBelow).toBeUndefined();
  });
});

describe('helpers', () => {
  it('sigma, half and contributions', () => {
    const items = stack(byId('SU-01'));
    expect(halfOf(items[0]!)).toBeCloseTo(0.1, 12);
    expect(sigmaOf({ ...items[0]!, distribution: 'uniform' }, 3)).toBeCloseTo(0.1 / Math.sqrt(3), 12);
    const shares = contributions(items, 3);
    expect(shares.reduce((s, c) => s + c.wcPercent, 0)).toBeCloseTo(100, 9);
    expect(shares.reduce((s, c) => s + c.rssPercent, 0)).toBeCloseTo(100, 9);
    expect(contributions([{ ...items[0]!, lower: 0, upper: 0 }], 3)[0]).toEqual({ name: 'H', wcPercent: 0, rssPercent: 0 });
  });

  it('uniformSumCdf edge cases and mixed / empty probabilities', () => {
    expect(uniformSumCdf([], 1)).toBe(1);
    expect(uniformSumCdf([], -1)).toBe(0);
    expect(uniformSumCdf([1, 1], -5)).toBe(0);
    expect(uniformSumCdf([1, 1], 5)).toBe(1);
    expect(uniformSumCdf([1], 0)).toBeCloseTo(0.5, 12);
    const items = stack(byId('SU-01'));
    expect(exactProbabilities([], 0, 3, 0, 1)).toBeNull();
    expect(exactProbabilities([items[0]!, { ...items[1]!, distribution: 'uniform' }], 0, 3, 0, undefined)).toBeNull();
    expect(exactProbabilities(items, 0.15, 3, undefined, 0.3)?.pAbove).toBeGreaterThan(0);
  });
});

describe('parseStackExpression', () => {
  const names = ['a', 'b'];
  it('evaluates the grammar and differentiates every supported function', () => {
    const cases: Array<[string, number[], number]> = [
      ['a*b + a/b - -a', [2, 4], 2 * 4 + 0.5 + 2],
      ['sin(a) + cos(a) + tan(a)', [0.4, 1], Math.sin(0.4) + Math.cos(0.4) + Math.tan(0.4)],
      ['asin(a) + acos(a) + atan(a)', [0.3, 1], Math.asin(0.3) + Math.acos(0.3) + Math.atan(0.3)],
      ['sqrt(a) + abs(-a) + exp(a) + ln(a)', [2, 1], Math.sqrt(2) + 2 + Math.exp(2) + Math.log(2)],
      ['pow(a, b) + hypot(a, b) + pi + tau + 1.5e1 + .5', [2, 3], 8 + Math.hypot(2, 3) + Math.PI + 2 * Math.PI + 15 + 0.5],
    ];
    for (const [source, point, expected] of cases) {
      const parsed = parseStackExpression(source, names);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(compileStackExpression(parsed.tree)(point)).toBeCloseTo(expected, 12);
      const { value, gradient } = stackGradient(parsed.tree, point);
      expect(value).toBeCloseTo(expected, 12);
      const h = 1e-6;
      const f = compileStackExpression(parsed.tree);
      gradient.forEach((g, i) => {
        const up = point.map((x, k) => (k === i ? x + h : x));
        const down = point.map((x, k) => (k === i ? x - h : x));
        expect(g).toBeCloseTo((f(up) - f(down)) / (2 * h), 5);
      });
    }
  });

  it('reports parse errors', () => {
    const errors = ['a +', 'a $ b', 'c', 'foo(a)', 'sin(a, b)', '(a', 'a b', 'floor(a)', ''];
    for (const source of errors) expect(parseStackExpression(source, names).ok).toBe(false);
  });
});
