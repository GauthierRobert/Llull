import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { normalCdf } from '@cae/reliability/numerics';
import { code, data, lognormal, modelDoc, normal, relative, rMinusS, type Json } from './support';

const PF_EXACT = 0.0227501319482;
const propagate = (doc: Parameters<typeof execute>[0], params: Json): ReturnType<typeof execute> =>
  execute(doc, 'propagate_uncertainty', { limitState: 'g', ...params });
const limitData = (result: ReturnType<typeof execute>): Json => (data(result)['limitStates'] as Record<string, Json>)['g'] as Json;

describe('propagate_uncertainty: Monte Carlo and Latin hypercube (VC-PRB-01.d)', () => {
  it.each(['mc', 'lhs', 'lhs_centred'] as const)('%s with N = 200000 lands inside the 5-sigma binomial bound of the exact Pf', (method) => {
    const doc = rMinusS();
    const before = JSON.stringify(doc);
    const result = propagate(doc, { method, samples: 200000, seed: 20261015 });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const d = limitData(result);
    expect(Math.abs((d['pf'] as number) - PF_EXACT)).toBeLessThan(1.66705e-3);
    const wilson = d['wilson95'] as [number, number];
    expect(wilson[0]).toBeLessThan(d['pf'] as number);
    expect(wilson[1]).toBeGreaterThan(d['pf'] as number);
    const g = d['g'] as { mean: number; sd: number; histogram: { counts: number[] } };
    expect(Math.abs(g.mean - 100)).toBeLessThan((5 * 50) / Math.sqrt(200000));
    expect(Math.abs(g.sd - 50)).toBeLessThan((5 * 50) / Math.sqrt(2 * 200000));
    expect(g.histogram.counts.reduce((sum, c) => sum + c, 0)).toBe(200000);
    expect(data(result)['prng']).toBe('xoshiro128**');
    expect(d['reviewRequired']).toBe(true);
  });

  it('is bit-identical for the same model, method, samples and seed and differs for another seed (VC-PRB-10)', () => {
    const doc = rMinusS();
    const run = (seed: number): unknown => data(propagate(doc, { method: 'mc', samples: 5000, seed }));
    expect(run(11)).toEqual(run(11));
    expect(run(11)).not.toEqual(run(12));
  });

  it('matches the exact Pf of lognormal R and S within the binomial bound', () => {
    const doc = modelDoc([lognormal('R', 300, 30), lognormal('S', 200, 40)], 'R - S');
    const exact = normalCdf(-1.89451599469);
    const pf = limitData(propagate(doc, { method: 'lhs', samples: 200000, seed: 5 }))['pf'] as number;
    expect(Math.abs(pf - exact)).toBeLessThan(5 * Math.sqrt((exact * (1 - exact)) / 200000));
  });

  it('honours correlation between normals', () => {
    const doc = execute(rMinusS(), 'set_correlation', {
      names: ['R', 'S'],
      matrix: [
        [1, 0.5],
        [0.5, 1],
      ],
    }).document;
    const sd = Math.sqrt(30 ** 2 + 40 ** 2 - 2 * 0.5 * 30 * 40);
    const g = limitData(propagate(doc, { method: 'mc', samples: 100000, seed: 3 }))['g'] as { sd: number };
    expect(Math.abs(g.sd - sd)).toBeLessThan((5 * sd) / Math.sqrt(2 * 100000));
  });

  it('warns when no sample fails (rule of three) and when the estimate has not converged', () => {
    const safe = modelDoc([normal('R', 300, 1), normal('S', 100, 1)], 'R - S');
    const none = limitData(propagate(safe, { method: 'mc', samples: 1000, seed: 1 }));
    expect(none['belowResolution']).toBe(true);
    expect(none['pfUpperBound']).toBe(0.003);
    expect((none['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_PF_BELOW_RESOLUTION');
    const coarse = limitData(propagate(rMinusS(), { method: 'mc', samples: 1000, seed: 1 }));
    expect((coarse['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_MC_NOT_CONVERGED');
  });

  it('counts samples where g cannot be evaluated and reports them', () => {
    const doc = modelDoc([normal('x', 0, 1)], '1 / x - 5');
    const d = limitData(propagate(doc, { method: 'mc', samples: 200, seed: 2 }));
    expect(d['failedSamples']).toBe(0);
    const never = modelDoc([normal('x', 0, 1)], '1 / (x - x)');
    const failed = limitData(propagate(never, { method: 'mc', samples: 50, seed: 2 }));
    expect(failed['failedSamples']).toBe(50);
    expect((failed['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_RESPONSE_FAILED');
    const some = modelDoc([normal('x', 1, 1)], 'sqrt(x)');
    const partial = limitData(propagate(some, { method: 'mc', samples: 2000, seed: 2 }));
    expect(partial['failedSamples'] as number).toBeGreaterThan(0);
    expect(partial['validSamples'] as number).toBeLessThan(2000);
  });

  it('runs every limit state when none is named', () => {
    const doc = modelDoc([normal('R', 300, 30), normal('S', 200, 40)], 'R - S');
    const two = execute(doc, 'define_limit_state', { name: 'h', expression: 'R - 2 * S', unit: 'MPa' }).document;
    const result = execute(two, 'propagate_uncertainty', { method: 'lhs', samples: 2000, seed: 1 });
    expect(Object.keys(data(result)['limitStates'] as Json)).toEqual(['g', 'h']);
    expect(result.summary).toContain('g: Pf');
  });
});

describe('propagate_uncertainty: FOSM', () => {
  it('is exact for a linear limit state in normal variables: mean 100, sd 50, beta 2', () => {
    const result = propagate(rMinusS(), { method: 'fosm' });
    const d = limitData(result);
    expect(d['mean']).toBeCloseTo(100, 6);
    expect(d['sd'] as number).toBeCloseTo(50, 6);
    expect(d['beta'] as number).toBeCloseTo(2, 8);
    expect(relative(d['pf'] as number, PF_EXACT)).toBeLessThan(1e-7);
    const share = d['varianceShare'] as Record<string, number>;
    expect(share['R']).toBeCloseTo(0.36, 6);
    expect(share['S']).toBeCloseTo(0.64, 6);
    expect(data(result)['seed']).toBeUndefined();
  });

  it('accounts for correlation and linearises a non-linear g', () => {
    const doc = execute(rMinusS(), 'set_correlation', {
      names: ['R', 'S'],
      matrix: [
        [1, 0.5],
        [0.5, 1],
      ],
    }).document;
    expect(limitData(propagate(doc, { method: 'fosm' }))['sd'] as number).toBeCloseTo(Math.sqrt(1300), 5);
    const product = modelDoc([normal('a', 10, 1), normal('b', 5, 0.5)], 'a * b - 40');
    const d = limitData(propagate(product, { method: 'fosm' }));
    expect(d['mean']).toBeCloseTo(10, 8);
    expect(d['sd'] as number).toBeCloseTo(Math.sqrt(25 + 25), 4);
  });

  it('reports a zero-variance g', () => {
    const constant = modelDoc([normal('a', 10, 1)], '5 + 0 * a');
    const d = limitData(propagate(constant, { method: 'fosm' }));
    expect(d['beta']).toBeNull();
    expect((d['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_RESPONSE_FAILED');
  });
});

describe('propagate_uncertainty: failure paths', () => {
  const doc = rMinusS();

  it('needs a seed for sampling methods', () => {
    const result = propagate(doc, { method: 'mc' });
    expect(code(result)).toBe('PRB_PARAMS_INVALID');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(code(propagate(doc, {}))).toBe('PRB_PARAMS_INVALID');
  });

  it('caps the sample count at 2e6', () => {
    expect(code(propagate(doc, { samples: 2_000_001, seed: 1 }))).toBe('PRB_BUDGET_EXCEEDED');
  });

  it('refuses a model without limit states, an unknown limit state and invalid params', () => {
    expect(code(execute(createEmptyDocument(), 'propagate_uncertainty', { seed: 1 }))).toBe('PRB_MODEL_EMPTY');
    expect(code(propagate(doc, { limitState: 'nope', seed: 1 }))).toBe('PRB_LIMIT_STATE_NOT_FOUND');
    const invalid = propagate(doc, { method: 'sobol', seed: 1 });
    expect(invalid.document).toBe(doc);
    expect(invalid.summary).toMatch(/rejected/);
    expect(propagate(doc, { samples: 1, seed: 1 }).summary).toMatch(/rejected/);
  });
});
