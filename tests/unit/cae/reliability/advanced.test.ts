/** PRB M4 numerics: importance sampling, Morris screening and the quadratic response surface, each against a closed form. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { importanceSampling } from '@cae/reliability/importance';
import { elementaryEffects } from '@cae/reliability/morris';
import { fitQuadraticSurface } from '@cae/reliability/surface';
import { erfc } from '@lib/specialFunctions';
import { code, data, modelDoc, normal, relative, rMinusS, type Json } from './support';
import { massModel } from './responses.support';

const phiOfMinus = (beta: number): number => 0.5 * erfc(beta / Math.SQRT2);
const uniform01 = (name: string): { name: string; distribution: Json } => ({ name, distribution: { kind: 'uniform', min: 0, max: 1 } });
const study = (doc: Parameters<typeof execute>[0], params: Json): ReturnType<typeof execute> =>
  execute(doc, 'run_reliability_study', { limitState: 'g', seed: 11, ...params });

describe('importance sampling (method "is" of run_reliability_study)', () => {
  it('reproduces Phi(-beta) = 0.0227501 of the linear R - S problem within 3 standard errors', () => {
    const result = study(rMinusS(), { methods: ['is'], samples: 4000 });
    const d = data(result)['importanceSampling'] as Json;
    expect(Math.abs((d['pf'] as number) - phiOfMinus(2))).toBeLessThan(3 * (d['standardError'] as number));
    // variance reduction: plain Monte Carlo of 4000 samples has SE sqrt(p(1-p)/4000) = 2.4e-3
    expect(d['standardError'] as number).toBeLessThan(0.3 * Math.sqrt((phiOfMinus(2) * (1 - phiOfMinus(2))) / 4000));
    const [low, high] = d['ci95'] as [number, number];
    expect(low).toBeLessThan(phiOfMinus(2));
    expect(high).toBeGreaterThan(phiOfMinus(2));
    expect(d['effectiveFailureSamples']).toBeGreaterThan(100);
    expect(d['effectiveFailureSamples'] as number).toBeLessThanOrEqual(4000);
    expect(result.document).toBeDefined();
    expect(result.affected).toEqual([]);
  });

  it('resolves a rare failure (beta = 7.07, Pf = 7.6e-13) where plain Monte Carlo of the same size sees nothing', () => {
    const doc = modelDoc([normal('R', 300, 10), normal('S', 200, 10)], 'R - S');
    const exact = phiOfMinus(100 / Math.sqrt(200));
    const d = data(study(doc, { methods: ['is', 'mc'], samples: 5000 }));
    expect(relative((d['importanceSampling'] as Json)['pf'] as number, exact)).toBeLessThan(0.05);
    expect((d['monteCarlo'] as Json)['pf']).toBe(0);
    expect((d['comparison'] as { pf: Record<string, number> }).pf['is']).toBeDefined();
  });

  it('is deterministic for the seed, needs one, and is capped like Monte Carlo', () => {
    const doc = rMinusS();
    const a = data(study(doc, { methods: ['is'], samples: 500 }))['importanceSampling'];
    expect(JSON.stringify(data(study(doc, { methods: ['is'], samples: 500 }))['importanceSampling'])).toBe(JSON.stringify(a));
    expect(JSON.stringify(data(study(doc, { methods: ['is'], samples: 500, seed: 12 }))['importanceSampling'])).not.toBe(JSON.stringify(a));
    const noSeed = execute(doc, 'run_reliability_study', { limitState: 'g', methods: ['is'] });
    expect(code(noSeed)).toBe('PRB_PARAMS_INVALID');
    expect(noSeed.document).toBe(doc);
    expect(code(study(doc, { methods: ['is'], samples: 3_000_000 }))).toBe('PRB_BUDGET_EXCEEDED');
  });

  it('the estimator excludes non-finite g, and NaN when none is finite; a failure-free draw is reported', () => {
    const some = importanceSampling((u) => ((u[0] ?? 0) > 0.5 ? Number.NaN : (u[0] ?? 0) - 2), [2], 400, 3);
    expect(some.validSamples).toBeLessThan(400);
    expect(some.validSamples).toBeGreaterThan(0);
    expect(Number.isNaN(importanceSampling(() => Number.NaN, [1], 10, 3).pf)).toBe(true);
    const none = data(study(modelDoc([normal('R', 300, 1)], 'pow(R - 300, 2) + 1'), { methods: ['is'], samples: 50 }))[
      'importanceSampling'
    ] as Json;
    expect((none['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_PF_BELOW_RESOLUTION');
  });
});

describe('elementaryEffects (Morris)', () => {
  it('f = q^2: the effect is 2q + delta, so mu = mu* = 1 and sigma = 1/3 over the start levels {0, 1/3} (delta = 2/3)', () => {
    const result = elementaryEffects((q) => (q[0] ?? 0) ** 2, 1, 4000, 4, 5);
    expect(result.delta).toBeCloseTo(2 / 3, 12);
    expect(result.effects[0]?.mu).toBeCloseTo(1, 1);
    expect(result.effects[0]?.muStar).toBeCloseTo(1, 1);
    expect(result.effects[0]?.sigma).toBeCloseTo(1 / 3, 1);
    expect(result.evaluations).toBe(8000);
  });

  it('is exact for a linear function: mu = mu* = coefficient, sigma = 0', () => {
    const result = elementaryEffects((q) => 3 * (q[0] ?? 0) - 2 * (q[1] ?? 0), 2, 10, 6, 1);
    expect(result.effects[0]?.mu).toBeCloseTo(3, 10);
    expect(result.effects[1]?.mu).toBeCloseTo(-2, 10);
    expect(result.effects[1]?.muStar).toBeCloseTo(2, 10);
    expect(result.effects[1]?.sigma).toBeCloseTo(0, 8);
  });
});

describe('morris_screening', () => {
  const linear = modelDoc([uniform01('x1'), uniform01('x2'), uniform01('x3')], '5 * x1 - 2 * x2 + 0 * x3');
  const run = (doc: Parameters<typeof execute>[0], params: Json): ReturnType<typeof execute> =>
    execute(doc, 'morris_screening', { limitState: 'g', seed: 4, ...params });
  type Row = { name: string; mu: number; muStar: number; sigma: number };

  it('a linear limit state gives mu = coefficient (per unit probability), sigma = 0, and flags the idle variable', () => {
    const doc = linear;
    const before = JSON.stringify(doc);
    const result = run(doc, { trajectories: 8 });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    const rows = data(result)['variables'] as Row[];
    expect(relative(rows[0]?.mu ?? 0, 5)).toBeLessThan(1e-4);
    expect(relative(rows[1]?.mu ?? 0, -2)).toBeLessThan(1e-4);
    expect(relative(rows[1]?.muStar ?? 0, 2)).toBeLessThan(1e-4);
    expect(rows[0]?.sigma).toBeLessThan(1e-6);
    expect(rows[2]?.muStar).toBeLessThan(1e-9);
    expect(data(result)['ranking']).toEqual(['x1', 'x2', 'x3']);
    expect(data(result)['evaluations']).toBe(8 * 4);
    expect((data(result)['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_NO_INFLUENCE');
  });

  it('shows non-linearity and interaction through sigma, and is deterministic', () => {
    const doc = modelDoc([uniform01('x1'), uniform01('x2'), uniform01('x3')], 'x1 + 2 * pow(x2, 2) + 5 * x1 * x3');
    const rows = data(run(doc, { trajectories: 30 }))['variables'] as Row[];
    expect(rows[0]?.sigma).toBeGreaterThan(0.5);
    expect(rows[1]?.sigma).toBeGreaterThan(0.2);
    expect(rows[2]?.muStar).toBeGreaterThan(0.5);
    expect(JSON.stringify(run(doc, { trajectories: 30 }).data)).toBe(JSON.stringify(run(doc, { trajectories: 30 }).data));
  });

  it('ranks the box dimensions through the registry (response path): the width matters least', () => {
    const { doc } = massModel();
    const result = run(doc, { limitState: undefined, response: 'mass', trajectories: 6 });
    expect(code(result)).toBeUndefined();
    expect((data(result)['ranking'] as string[])[2]).toBe('w_rv');
  });

  it('refuses bad input without changing the document', () => {
    const refused = (params: Json, doc = linear): string | undefined => {
      const result = run(doc, params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      return code(result);
    };
    expect(refused({ limitState: undefined })).toBe('PRB_PARAMS_INVALID');
    expect(refused({ response: 'mass' })).toBe('PRB_PARAMS_INVALID');
    expect(refused({ levels: 5 })).toBe('PRB_PARAMS_INVALID');
    expect(refused({ limitState: 'nope' })).toBe('PRB_LIMIT_STATE_NOT_FOUND');
    expect(refused({ limitState: undefined, response: 'nope' })).toBe('PRB_RESPONSE_NOT_FOUND');
    expect(refused({ trajectories: 1 })).toBe('CMD_INVALID_PARAMS');
    expect(refused({ trajectories: 1_000_000 })).toBe('PRB_BUDGET_EXCEEDED');
    expect(refused({}, modelDoc([normal('R', 300, 30)], 'ln(310 - R)'))).toBe('PRB_RESPONSE_FAILED');
    const correlated = execute(rMinusS(), 'set_correlation', {
      names: ['R', 'S'],
      matrix: [
        [1, 0.5],
        [0.5, 1],
      ],
    }).document;
    expect(refused({}, correlated)).toBe('PRB_SOBOL_CORRELATED');
  });
});

describe('quadratic response surface', () => {
  it('reproduces an exact quadratic, with LOO residual ~ 0, and rejects too few / duplicated points', () => {
    const points = Array.from({ length: 30 }, (_, k) => [Math.sin(k + 1) * 2, Math.cos(2 * k) * 2]);
    const f = (u: readonly number[]): number =>
      1 + 2 * (u[0] ?? 0) - 3 * (u[1] ?? 0) + 0.5 * (u[0] ?? 0) * (u[1] ?? 0) + 0.1 * (u[1] ?? 0) ** 2;
    const surface = fitQuadraticSurface(points, points.map(f));
    expect(surface?.rSquared).toBeCloseTo(1, 10);
    expect(surface?.looRmse).toBeLessThan(1e-6);
    expect(surface?.coefficients[0]).toBeCloseTo(1, 8);
    expect(surface?.evaluate([1, 1])).toBeCloseTo(f([1, 1]), 8);
    expect(fitQuadraticSurface(points.slice(0, 5), [1, 2, 3, 4, 5])).toBeNull();
    expect(
      fitQuadraticSurface(
        Array.from({ length: 12 }, () => [1, 1]),
        new Array<number>(12).fill(0),
      ),
    ).toBeNull();
  });

  const run = (doc: Parameters<typeof execute>[0], params: Json): ReturnType<typeof execute> =>
    execute(doc, 'response_surface_study', { limitState: 'g', seed: 21, points: 60, ...params });

  it('is exact for the SORM benchmark g = 3 - u1 + 0.1 u2^2: FORM beta 3 and Pf of the surface = 1.04359876e-3 (VC-PRB-04)', () => {
    const doc = modelDoc([normal('u1', 0, 1), normal('u2', 0, 1)], '3 - u1 + 0.1 * pow(u2, 2)');
    const before = JSON.stringify(doc);
    const result = run(doc, { samples: 800_000, spread: 2 });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    const d = data(result);
    const surface = d['surface'] as Json;
    expect(1 - (surface['rSquared'] as number)).toBeLessThan(1e-9);
    expect(surface['looRelative'] as number).toBeLessThan(1e-6);
    const form = d['form'] as Json;
    expect(Math.abs((form['beta'] as number) - 3)).toBeLessThan(1e-6);
    const mc = d['monteCarlo'] as Json;
    expect(Math.abs((mc['pf'] as number) - 1.04359875879e-3)).toBeLessThan(5 * (mc['standardError'] as number));
    expect(d['items']).toEqual([]);
    expect(result.summary).toContain('6-term quadratic');
    expect(d['reviewRequired']).toBe(true);
  });

  it('flags a response the quadratic cannot represent (PRB_SURFACE_RESIDUAL)', () => {
    const doc = modelDoc([normal('u1', 0, 1)], '5 - exp(1.5 * u1)');
    const d = data(run(doc, { points: 40, samples: 1000 }));
    expect((d['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_SURFACE_RESIDUAL');
    expect((d['surface'] as Json)['looRelative'] as number).toBeGreaterThan(0.05);
  });

  it('works on a response through the registry (box mass) and refuses bad input unchanged', () => {
    const { doc } = massModel();
    const result = run(doc, { limitState: undefined, response: 'mass', points: 40, samples: 1000 });
    expect(code(result)).toBeUndefined();
    expect((data(result)['surface'] as Json)['rSquared'] as number).toBeGreaterThan(0.99999);
    const refused = (params: Json, on = doc): string | undefined => {
      const r = run(on, params);
      expect(r.document).toBe(on);
      return code(r);
    };
    expect(refused({ limitState: undefined })).toBe('PRB_PARAMS_INVALID');
    expect(refused({ limitState: 'nope' })).toBe('PRB_LIMIT_STATE_NOT_FOUND');
    expect(refused({ limitState: undefined, response: 'mass', points: 9 })).toBe('PRB_PARAMS_INVALID');
    expect(refused({ limitState: undefined, response: 'mass', points: 30_000 })).toBe('PRB_BUDGET_EXCEEDED');
    expect(refused({ samples: 2_000_000 }, modelDoc([normal('a', 0, 1)], 'a'))).toBeUndefined();
    expect(refused({}, modelDoc([normal('R', 300, 30)], 'ln(310 - R)'))).toBe('PRB_RESPONSE_FAILED');
    expect(refused({ points: 3 }, modelDoc([normal('a', 0, 1)], 'a'))).toBe('PRB_PARAMS_INVALID');
  });
});
