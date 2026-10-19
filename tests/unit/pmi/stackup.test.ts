/** analyze_stackup (VC-GDT-30..35, 55, 58) and fastener_tolerance (FF-01..03) against docs/aerospace/03-gdt-mbd-pmi/validation. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { erfc, normalCdf, uniformSumCdf } from '@lib/stackup';
import { programFunction } from '@lib/expressionProgram';
import { sampleStackup, STACKUP_CHUNK } from '@lib/stackupSampling';
import reference from '../../../docs/aerospace/03-gdt-mbd-pmi/validation/stackup_reference.json';
import { data, expectRefusal } from '../../helpers/commandAssertions';

interface Bounds {
  min: number;
  max: number;
  halfTolerance?: number;
}
interface Stack {
  yNominal: number;
  yMean: number;
  worstCase: Bounds;
  worstCaseExactCorners: Bounds | null;
  rss: Bounds;
  sigma: number;
  pBelowLowerLimit?: number | null;
  pAboveUpperLimit?: number | null;
  pMethod?: string;
  contributions: { name: string; wcPercent: number; rssPercent: number; sensitivity: number }[];
  monteCarlo?: {
    seed: number;
    samples: number;
    prng: string;
    engine: string;
    mean: number;
    std: number;
    min: number;
    max: number;
    pBelowLowerLimit?: number;
    acceptance: { meanTolerance: number; stdTolerance: number; pTolerance: number | null };
  };
  sigmaPerHalfTolerance: { value: number; defaulted: boolean; source: string };
  provenance: { sensitivitySource: string };
  unverified?: { contributors: string[] };
  warnings: { code: string }[];
  reviewRequired: boolean;
}

const doc = createEmptyDocument();
type Case = (typeof reference.stackups)[number];

const linearParams = (stack: Case, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: stack.id,
  contributors: stack.contributors.map((c) => ({
    name: c.name,
    nominal: c.nominal,
    upper: c.upper,
    lower: c.lower,
    sensitivity: c.sensitivity,
    ...('distribution' in c ? { distribution: c.distribution } : {}),
  })),
  ...('lowerSpecLimit' in stack.analytic ? { lowerSpecLimit: stack.analytic.lowerSpecLimit } : {}),
  ...extra,
});

const su = (id: string): Case => reference.stackups.find((s) => s.id === id) as Case;
const close = (actual: number, expected: number, tolerance = 1e-9): void =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

describe('stack-up math (lib/stackup)', () => {
  it('erfc has double-precision accuracy (relative < 1e-12) on both branches', () => {
    for (const [x, value] of [
      [0.5, 0.4795001221869535],
      [1, 0.15729920705028513],
      [3, 2.209049699858544e-5],
      [5, 1.5374597944280349e-12],
    ] as const)
      expect(Math.abs(erfc(x) - value) / value).toBeLessThan(1e-12);
    expect(erfc(-1)).toBeCloseTo(2 - 0.15729920705028513, 15);
    expect(Math.abs(normalCdf(-3) - 0.0013498980316300946) / 0.0013498980316300946).toBeLessThan(1e-12);
  });

  it('uniform-sum CDF: one uniform is linear, two give the triangle, > 12 terms refuse', () => {
    expect(uniformSumCdf(0.25, [{ lo: 0, width: 1 }])).toBeCloseTo(0.25, 15);
    expect(
      uniformSumCdf(0.5, [
        { lo: 0, width: 1 },
        { lo: 0, width: 1 },
      ]),
    ).toBeCloseTo(0.125, 15);
    expect(uniformSumCdf(5, [{ lo: 0, width: 0 }])).toBe(1);
    expect(uniformSumCdf(-1, [{ lo: 0, width: 0 }])).toBe(0);
    expect(uniformSumCdf(0, new Array(13).fill({ lo: 0, width: 1 }))).toBeNull();
  });

  it('chunked sampling: chunks merge in order, result independent of nothing but (seed, samples, inputs)', () => {
    const input = {
      contributors: [
        { centre: 1, half: 0.1, sigma: 0.1 / 3, distribution: 'normal' as const },
        { centre: 2, half: 0.2, sigma: 0.2 / Math.sqrt(3), distribution: 'uniform' as const },
        { centre: 3, half: 0.3, sigma: 0.1, distribution: 'normal' as const },
      ],
      evaluate: (x: ArrayLike<number>) => (x[0] as number) + (x[1] as number) - (x[2] as number),
      samples: 3 * STACKUP_CHUNK + 17,
      seed: 99,
      lowerSpecLimit: -0.2,
      upperSpecLimit: 0.2,
    };
    const a = sampleStackup(input);
    expect(sampleStackup(input)).toEqual(a);
    expect(a.samples).toBe(3 * STACKUP_CHUNK + 17);
    expect(a.below + a.above).toBeGreaterThan(0);
    expect(sampleStackup({ ...input, seed: 100 }).mean).not.toBe(a.mean);
    expect(sampleStackup({ ...input, evaluate: () => Number.NaN }).nonFinite).toBe(input.samples);
  });
});

describe('analyze_stackup closed forms (VC-GDT-30..35)', () => {
  it.each(['SU-01', 'SU-02', 'SU-03', 'SU-04'])('%s linear stack matches the analytic reference', (id) => {
    const stack = su(id);
    const result = data<Stack>(doc, 'analyze_stackup', linearParams(stack));
    const a = stack.analytic;
    close(result.yNominal, a.yNominal);
    close(result.yMean, a.yMean);
    close(result.worstCase.min, a.worstCase.min);
    close(result.worstCase.max, a.worstCase.max);
    close(result.worstCase.halfTolerance as number, a.worstCase.halfTolerance);
    close((result.worstCaseExactCorners as Bounds).min, a.worstCaseExactCorners.min);
    close((result.worstCaseExactCorners as Bounds).max, a.worstCaseExactCorners.max);
    close(result.rss.halfTolerance as number, a.rss.halfTolerance);
    close(result.sigma, a.sigma);
    const p = a.pBelowLowerLimit as number;
    close(result.pBelowLowerLimit as number, p, 1e-12);
    expect(result.pMethod).toBe(id === 'SU-02' ? 'uniform_sum' : 'normal');
    expect(result.provenance.sensitivitySource).toBe('given');
    expect(result.contributions.reduce((sum, row) => sum + row.rssPercent, 0)).toBeCloseTo(100, 9);
    expect(result.contributions.reduce((sum, row) => sum + row.wcPercent, 0)).toBeCloseTo(100, 9);
  });

  it('SU-05 non-linear expression: autodiff sensitivities, exact corners differ from the linearised WC', () => {
    const stack = su('SU-05');
    const result = data<Stack>(doc, 'analyze_stackup', {
      expression: stack.expression,
      contributors: stack.contributors.map(({ name, nominal, upper, lower }) => ({ name, nominal, upper, lower })),
    });
    const a = stack.analytic;
    close(result.yMean, a.yMean);
    close(result.worstCase.halfTolerance as number, a.worstCase.halfTolerance);
    close((result.worstCaseExactCorners as Bounds).min, a.worstCaseExactCorners.min);
    close((result.worstCaseExactCorners as Bounds).max, a.worstCaseExactCorners.max);
    close(result.rss.halfTolerance as number, a.rss.halfTolerance);
    close(result.sigma, a.sigma);
    expect(result.provenance.sensitivitySource).toBe('autodiff');
    expect(result.reviewRequired).toBe(true);
  });

  it('VC-GDT-58: the SU-01 plan by expression names its defaults and uses autodiff', () => {
    const stack = su('SU-01');
    const result = data<Stack>(doc, 'analyze_stackup', {
      expression: 'gap = H - (A + B + C + D)',
      lowerSpecLimit: 0,
      contributors: stack.contributors.map(({ name, nominal, upper, lower }) => ({ name, nominal, upper, lower })),
    });
    expect(result.sigmaPerHalfTolerance).toMatchObject({ value: 3, defaulted: true });
    expect(result.provenance.sensitivitySource).toBe('autodiff');
    close(result.sigma, stack.analytic.sigma);
    expect(result.contributions.map((row) => row.sensitivity)).toEqual([1, -1, -1, -1, -1]);
    expect(result.monteCarlo).toBeUndefined();
  });

  it('VC-GDT-55: verified false is listed as unverified with a GDT_UNVERIFIED_INPUT warning; RSS unchanged', () => {
    const params = linearParams(su('SU-01'));
    const contributors = (params['contributors'] as Record<string, unknown>[]).map((c) =>
      c['name'] === 'C' ? { ...c, verified: false } : c,
    );
    const result = data<Stack>(doc, 'analyze_stackup', { ...params, contributors, upperSpecLimit: 0.3, sigmaPerHalfTolerance: 3 });
    expect(result.unverified).toEqual({ contributors: ['C'] });
    expect(result.warnings.map((w) => w.code)).toEqual(['GDT_UNVERIFIED_INPUT']);
    close(result.rss.halfTolerance as number, 0.124096736);
    expect(result.sigmaPerHalfTolerance.defaulted).toBe(false);
    expect(result.pAboveUpperLimit as number).toBeCloseTo(1 - normalCdf((0.3 - 0.15) / result.sigma), 14);
    expect(result.reviewRequired).toBe(true);
  });
});

describe('analyze_stackup Monte Carlo (VC-GDT-30..35 acceptance bounds)', () => {
  it.each(['SU-01', 'SU-02', 'SU-03', 'SU-04', 'SU-05'])('%s: seed 20261015, N 200000 within the 5σ acceptance bounds', (id) => {
    const stack = su(id);
    const base =
      id === 'SU-05'
        ? {
            expression: stack.expression,
            contributors: stack.contributors.map(({ name, nominal, upper, lower }) => ({ name, nominal, upper, lower })),
          }
        : linearParams(stack);
    const result = data<Stack>(doc, 'analyze_stackup', {
      ...base,
      methods: ['worstCase', 'rss', 'monteCarlo'],
      samples: stack.monteCarlo.samples,
      seed: stack.monteCarlo.seed,
    });
    const mc = result.monteCarlo as NonNullable<Stack['monteCarlo']>;
    const acceptance = stack.monteCarlo.acceptance;
    expect(mc).toMatchObject({ prng: 'philox4x32-10', engine: 'ts', samples: 200_000, seed: 20261015 });
    expect(Math.abs(mc.mean - stack.analytic.yMean)).toBeLessThanOrEqual(acceptance.meanTolerance);
    expect(Math.abs(mc.std - stack.analytic.sigma)).toBeLessThanOrEqual(acceptance.stdTolerance);
    if ('pTolerance' in acceptance)
      expect(Math.abs((mc.pBelowLowerLimit as number) - (stack.analytic.pBelowLowerLimit as number))).toBeLessThanOrEqual(
        acceptance.pTolerance,
      );
    expect(mc.acceptance.meanTolerance).toBeCloseTo(acceptance.meanTolerance, 8);
    expect(mc.min).toBeGreaterThanOrEqual(result.worstCase.min - 2 * (result.worstCase.halfTolerance as number));
  });

  it('is deterministic per (seed, samples) and is pure', () => {
    const params = { ...linearParams(su('SU-01')), methods: ['monteCarlo'], samples: 5000 };
    const before = structuredClone(doc);
    const first = execute(doc, 'analyze_stackup', params);
    const second = execute(doc, 'analyze_stackup', params);
    expect(second.data).toEqual(first.data);
    expect(first.document).toBe(doc);
    expect(doc).toEqual(before);
    expect(first.summary).toContain('Monte Carlo 5000 samples');
    const mc = (first.data as Stack).monteCarlo as NonNullable<Stack['monteCarlo']>;
    expect(mc).toMatchObject({ seed: 1, seedDefaulted: true });
    expect((first.data as Stack).worstCase).toBeUndefined();
  });

  it('the program evaluator gives the expression bits used by the sampler', () => {
    const stats = sampleStackup({
      contributors: [{ centre: 2, half: 0.1, sigma: 0.05, distribution: 'normal' }],
      evaluate: programFunction([
        { op: 'var', index: 0 },
        { op: 'call', fn: 'sqrt', argc: 1 },
      ]),
      samples: 2000,
      seed: 5,
    });
    expect(stats.mean).toBeCloseTo(Math.SQRT2, 2);
  });
});

describe('analyze_stackup refusals', () => {
  const one = [{ name: 'A', nominal: 1, upper: 0.1, lower: -0.1, sensitivity: 1 }];
  it.each([
    [{ contributors: [] }, 'GDT_STACKUP_CONTRIBUTOR_INVALID', 'contributors'],
    [{ contributors: [{ ...one[0], name: '1x' }] }, 'GDT_STACKUP_CONTRIBUTOR_INVALID', 'contributors.0.name'],
    [{ contributors: [one[0], one[0]] }, 'GDT_STACKUP_CONTRIBUTOR_INVALID', 'contributors.1.name'],
    [{ contributors: [{ ...one[0], lower: 0.2 }] }, 'GDT_LIMITS_INVERTED', 'contributors.0.lower'],
    [{ contributors: one, expression: 'A' }, 'GDT_STACKUP_SENSITIVITY_CONFLICT', 'expression'],
    [{ contributors: [{ name: 'A', nominal: 1, upper: 0, lower: 0 }] }, 'GDT_STACKUP_SENSITIVITY_CONFLICT', 'expression'],
    [{ contributors: [{ name: 'A', nominal: 1, upper: 0, lower: 0 }], expression: 'A + B' }, 'GDT_STACKUP_EXPRESSION', 'expression'],
    [{ contributors: one, samples: 2_000_001 }, 'GDT_STACKUP_SAMPLES_CAP', 'samples'],
    [{ contributors: one, samples: 10 }, 'GDT_STACKUP_SAMPLES_CAP', 'samples'],
    [{ contributors: one, sigmaPerHalfTolerance: 0 }, 'GDT_STACKUP_CONTRIBUTOR_INVALID', 'sigmaPerHalfTolerance'],
    [{ contributors: one, seed: -1 }, 'GDT_STACKUP_CONTRIBUTOR_INVALID', 'seed'],
  ])('%j -> %s', (params, code, path) => {
    expectRefusal(doc, 'analyze_stackup', params, code, path);
  });

  it('a non-finite sample refuses with GDT_STACKUP_NON_FINITE', () => {
    expectRefusal(
      doc,
      'analyze_stackup',
      { contributors: [{ name: 'A', nominal: 0, upper: 1, lower: -1 }], expression: 'sqrt(A)', methods: ['monteCarlo'], samples: 1000 },
      'GDT_STACKUP_NON_FINITE',
      'expression',
    );
  });

  it('mixed distributions give no closed-form probability (Monte Carlo only)', () => {
    const result = data<Stack>(doc, 'analyze_stackup', {
      contributors: [
        { name: 'A', nominal: 1, upper: 0.1, lower: -0.1, sensitivity: 1 },
        { name: 'B', nominal: 1, upper: 0.1, lower: -0.1, sensitivity: -1, distribution: 'uniform', unit: 'deg' },
      ],
      lowerSpecLimit: -0.1,
      upperSpecLimit: 0.1,
    });
    expect(result.pBelowLowerLimit).toBeNull();
    expect(result.pMethod).toBe('none');
    expect(result.contributions[1]).toMatchObject({ unit: 'deg' });
  });
});

describe('fastener_tolerance (FF-01..03)', () => {
  const [ff1, ff2, ff3] = reference.fasteners as unknown as [
    { H: number; F: number; T_each: number },
    { H: number; F: number; T_each: number },
    Record<string, number>,
  ];
  it('floating: T = H − F (FF-01); fixed equal split: T1 = T2 = (H − F)/2 (FF-02)', () => {
    const floating = data<{ positionTolerance: number }>(doc, 'fastener_tolerance', {
      holeMmc: ff1.H,
      fastenerMmc: ff1.F,
      type: 'floating',
    });
    close(floating.positionTolerance, ff1.T_each, 1e-12);
    const fixed = data<{ perPart: { part1: number; part2: number }; splitDefaulted: boolean }>(doc, 'fastener_tolerance', {
      holeMmc: ff2.H,
      fastenerMmc: ff2.F,
      type: 'fixed',
    });
    close(fixed.perPart.part1, ff2.T_each, 1e-12);
    close(fixed.perPart.part2, ff2.T_each, 1e-12);
    expect(fixed.splitDefaulted).toBe(true);
  });

  it('MMC bonus and virtual condition (FF-03)', () => {
    const base = {
      holeMmc: ff3['sizeMMC'],
      fastenerMmc: 6,
      type: 'floating',
      holeLmc: ff3['sizeLMC'],
      statedPosition: ff3['statedPosition'],
    };
    const at = (actualSize: number): { allowedPosition: number; virtualCondition: number } =>
      data(doc, 'fastener_tolerance', { ...base, actualSize });
    close(at(ff3['sizeMMC'] as number).allowedPosition, ff3['allowedPositionAtMMC'] as number, 1e-12);
    close(at(ff3['sizeLMC'] as number).allowedPosition, ff3['allowedPositionAtLMC'] as number, 1e-12);
    close(at(6.75).allowedPosition, ff3['allowedPositionAtSize6_75'] as number, 1e-12);
    close(at(6.75).virtualCondition, ff3['virtualCondition'] as number, 1e-12);
  });

  it.each([
    [{ holeMmc: 6, fastenerMmc: 6, type: 'floating' }, 'GDT_FASTENER_HOLE_LE_FASTENER', 'holeMmc'],
    [{ holeMmc: 0, fastenerMmc: 6, type: 'floating' }, 'GDT_FASTENER_PARAM_INVALID', 'holeMmc'],
    [{ holeMmc: 7, fastenerMmc: 6, type: 'fixed', split: 1 }, 'GDT_FASTENER_PARAM_INVALID', 'split'],
    [{ holeMmc: 7, fastenerMmc: 6, type: 'fixed', holeLmc: 6.5 }, 'GDT_FASTENER_PARAM_INVALID', 'holeLmc'],
    [{ holeMmc: 7, fastenerMmc: 6, type: 'fixed', statedPosition: -1 }, 'GDT_FASTENER_PARAM_INVALID', 'statedPosition'],
    [{ holeMmc: 7, fastenerMmc: 6, type: 'fixed', actualSize: 7.1 }, 'GDT_FASTENER_PARAM_INVALID', 'statedPosition'],
    [
      { holeMmc: 7, fastenerMmc: 6, type: 'fixed', statedPosition: 0.2, holeLmc: 7.2, actualSize: 7.3 },
      'GDT_FASTENER_PARAM_INVALID',
      'actualSize',
    ],
  ])('%j -> %s', (params, code, path) => {
    expectRefusal(doc, 'fastener_tolerance', params, code, path);
  });

  it('is pure and summarises the split', () => {
    const before = structuredClone(doc);
    const result = execute(doc, 'fastener_tolerance', { holeMmc: 6.6, fastenerMmc: 6, type: 'fixed', split: 0.25, statedPosition: 0.15 });
    expect(result.document).toBe(doc);
    expect(doc).toEqual(before);
    expect(result.summary).toContain('T1');
    expect(result.summary).toContain('VC');
  });
});
