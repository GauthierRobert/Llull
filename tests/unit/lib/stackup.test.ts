/**
 * 03 GDT M5: stack-up mathematics against docs/aerospace/03-gdt-mbd-pmi/validation/stackup_reference.json (VC-GDT-30..34), erfc and the
 * expression program. Merge note (2026-10-21): this suite was written for our xoshiro / stackExpression engine; it now drives main's engine
 * (`stackClosedForms`, `probabilityBelow`, `expressionProgram`). The PRNG checks moved to `prng.test.ts` (Philox known-answer vectors) and the
 * Monte Carlo checks to `tests/unit/pmi/stackup.test.ts` (bit-exact chunked sampler).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  contributions,
  halfToleranceOf,
  monteCarloAcceptance,
  probabilityBelow,
  rssHalf,
  sigmaOf,
  stackClosedForms,
  uniformSumCdf,
  worstCaseHalf,
  type StackContributor,
} from '@lib/stackup';
import { erfc, normalCdf } from '@lib/specialFunctions';
import { compileExpression, linearProgram, programFunction, programGradient, type Program } from '@lib/expressionProgram';

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
}

const reference = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../docs/aerospace/03-gdt-mbd-pmi/validation/stackup_reference.json'), 'utf8'),
) as { stackups: Reference[] };

const stack = (ref: Reference): StackContributor[] => ref.contributors.map((c) => ({ ...c, distribution: c.distribution ?? 'normal' }));
const byId = (id: string): Reference => reference.stackups.find((s) => s.id === id) as Reference;
const program = (items: readonly StackContributor[]): Program => linearProgram(items.map((c) => c.sensitivity));

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

describe('closed forms against stackup_reference.json (VC-GDT-30..34)', () => {
  for (const id of ['SU-01', 'SU-02', 'SU-03', 'SU-04']) {
    it(`${id}: worst case, RSS, sigma, corners and exact probability`, () => {
      const ref = byId(id);
      const items = stack(ref);
      const forms = stackClosedForms(items, program(items), 3);
      expect(forms.yMean).toBeCloseTo(ref.analytic.yMean, 9);
      expect(forms.worstCase.halfTolerance).toBeCloseTo(ref.analytic.worstCase.halfTolerance, 9);
      expect(worstCaseHalf(items)).toBeCloseTo(ref.analytic.worstCase.halfTolerance, 9);
      expect(forms.rss.halfTolerance).toBeCloseTo(ref.analytic.rss.halfTolerance, 9);
      expect(rssHalf(items)).toBeCloseTo(ref.analytic.rss.halfTolerance, 9);
      expect(forms.sigma).toBeCloseTo(ref.analytic.sigma, 9);
      expect(forms.worstCaseExactCorners?.min).toBeCloseTo(ref.analytic.worstCase.min, 9);
      expect(forms.worstCaseExactCorners?.max).toBeCloseTo(ref.analytic.worstCase.max, 9);
      const probability = probabilityBelow(ref.analytic.lowerSpecLimit as number, forms, items, true);
      expect(Math.abs((probability.p as number) - (ref.analytic.pBelowLowerLimit as number))).toBeLessThan(1e-12);
    });
  }

  it('SU-02 exact uniform probability is 29/2400', () => {
    const items = stack(byId('SU-02'));
    const p = probabilityBelow(0, stackClosedForms(items, program(items), 3), items, true);
    expect(p.p).toBeCloseTo(29 / 2400, 12);
    expect(p.method).toBe('uniform_sum');
  });

  it('SU-05: non-linear stack, exact autodiff sensitivities, linear WC and exact corners', () => {
    const ref = byId('SU-05');
    const compiled = compileExpression(ref.expression.split('=')[1]?.trim() ?? '', ['L', 'theta_deg']);
    expect(typeof compiled).not.toBe('string');
    if (typeof compiled === 'string') return;
    const items = stack(ref);
    const forms = stackClosedForms(items, compiled, 3);
    expect(forms.yMean).toBeCloseTo(50, 9);
    expect(forms.sensitivities[0]).toBeCloseTo(0.5, 12);
    expect(forms.sensitivities[1]).toBeCloseTo((100 * Math.cos(Math.PI / 6) * Math.PI) / 180, 12);
    expect(forms.worstCase.halfTolerance).toBeCloseTo(ref.analytic.worstCase.halfTolerance, 9);
    expect(forms.rss.halfTolerance).toBeCloseTo(ref.analytic.rss.halfTolerance, 9);
    expect(forms.sigma).toBeCloseTo(ref.analytic.sigma, 9);
    expect(forms.worstCaseExactCorners?.min).toBeCloseTo(ref.analytic.worstCaseExactCorners.min, 9);
    expect(forms.worstCaseExactCorners?.max).toBeCloseTo(ref.analytic.worstCaseExactCorners.max, 9);
    expect(probabilityBelow(49, forms, items, false).method).toBe('linearised_normal');
  });

  it('gives no corners above 16 contributors and no probability for mixed distributions', () => {
    const many = Array.from(
      { length: 17 },
      (_, i): StackContributor => ({ name: `c${i}`, nominal: 1, lower: 0, upper: 0, sensitivity: 1, distribution: 'normal' }),
    );
    expect(stackClosedForms(many, program(many), 3).worstCaseExactCorners).toBeNull();
    const items = stack(byId('SU-01'));
    const mixed = [items[0] as StackContributor, { ...(items[1] as StackContributor), distribution: 'uniform' as const }];
    expect(probabilityBelow(0, stackClosedForms(mixed, program(mixed), 3), mixed, true)).toEqual({ p: null, method: 'none' });
  });
});

describe('helpers', () => {
  it('sigma, half and contributions (the linear helpers of stackup_at_temperature)', () => {
    const items = stack(byId('SU-01'));
    const first = items[0] as StackContributor;
    expect(halfToleranceOf(first)).toBeCloseTo(0.1, 12);
    expect(sigmaOf({ ...first, distribution: 'uniform' }, 3)).toBeCloseTo(0.1 / Math.sqrt(3), 12);
    const shares = contributions(items, 3);
    expect(shares.reduce((s, c) => s + c.wcPercent, 0)).toBeCloseTo(100, 9);
    expect(shares.reduce((s, c) => s + c.rssPercent, 0)).toBeCloseTo(100, 9);
    expect(contributions([{ ...first, lower: 0, upper: 0 }], 3)[0]).toEqual({ name: 'H', wcPercent: 0, rssPercent: 0 });
  });

  it('uniformSumCdf edge cases and the acceptance probability floor', () => {
    expect(uniformSumCdf(1, [])).toBe(1);
    expect(uniformSumCdf(-1, [])).toBe(0);
    expect(
      uniformSumCdf(-5, [
        { lo: -1, width: 2 },
        { lo: -1, width: 2 },
      ]),
    ).toBe(0);
    expect(
      uniformSumCdf(5, [
        { lo: -1, width: 2 },
        { lo: -1, width: 2 },
      ]),
    ).toBe(1);
    expect(uniformSumCdf(0, [{ lo: -1, width: 2 }])).toBeCloseTo(0.5, 12);
    expect(
      uniformSumCdf(
        0,
        Array.from({ length: 13 }, () => ({ lo: 0, width: 1 })),
      ),
    ).toBeNull();
    expect(monteCarloAcceptance(1, 100, 0).pTolerance).toBe(1e-5);
    expect(monteCarloAcceptance(1, 100, null).pTolerance).toBeNull();
  });
});

describe('expression program', () => {
  const names = ['a', 'b'];
  it('evaluates the grammar and differentiates every differentiable function (central differences)', () => {
    const cases: Array<[string, number[], number]> = [
      ['a*b + a/b - -a', [2, 4], 2 * 4 + 0.5 + 2],
      ['sin(a) + cos(a) + tan(a)', [0.4, 1], Math.sin(0.4) + Math.cos(0.4) + Math.tan(0.4)],
      ['asin(a) + acos(a) + atan(a)', [0.3, 1], Math.asin(0.3) + Math.acos(0.3) + Math.atan(0.3)],
      ['sqrt(a) + abs(-a) + exp(a) + ln(a)', [2, 1], Math.sqrt(2) + 2 + Math.exp(2) + Math.log(2)],
      ['pow(a, b) + hypot(a, b) + pi + tau + 1.5e1 + .5', [2, 3], 8 + Math.hypot(2, 3) + Math.PI + 2 * Math.PI + 15 + 0.5],
    ];
    for (const [source, point, expected] of cases) {
      const compiled = compileExpression(source, names);
      expect(typeof compiled).not.toBe('string');
      if (typeof compiled === 'string') continue;
      const f = programFunction(compiled);
      expect(f(point)).toBeCloseTo(expected, 12);
      const { value, gradient } = programGradient(compiled, point);
      expect(value).toBeCloseTo(expected, 12);
      const h = 1e-6;
      gradient.forEach((g, i) => {
        const up = point.map((x, k) => (k === i ? x + h : x));
        const down = point.map((x, k) => (k === i ? x - h : x));
        expect(g).toBeCloseTo((f(up) - f(down)) / (2 * h), 5);
      });
    }
  });

  it('reports parse errors as text', () => {
    for (const source of ['a +', 'a $ b', 'c', 'foo(a)', '(a', 'a b', '']) expect(typeof compileExpression(source, names)).toBe('string');
  });
});
