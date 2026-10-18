import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { code, data, modelDoc, normal, relative, rMinusS, type Json } from './support';

const study = (doc: Parameters<typeof execute>[0], params: Json = {}): ReturnType<typeof execute> =>
  execute(doc, 'run_reliability_study', { limitState: 'g', seed: 7, samples: 100000, ...params });
const itemCodes = (d: Json): string[] => (d['items'] as Array<{ code: string }>).map((i) => i.code);

describe('run_reliability_study', () => {
  it('runs FORM, Monte Carlo and FOSM by default and the three agree on a linear normal problem', () => {
    const doc = rMinusS();
    const before = JSON.stringify(doc);
    const result = study(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const d = data(result);
    const pf = (d['comparison'] as { pf: Record<string, number>; formInsideMonteCarloInterval: boolean }).pf;
    expect(Object.keys(pf)).toEqual(['form', 'mc', 'fosm']);
    expect(relative(pf['form'] ?? 0, 0.0227501319482)).toBeLessThan(1e-8);
    expect(relative(pf['fosm'] ?? 0, 0.0227501319482)).toBeLessThan(1e-6);
    expect(Math.abs((pf['mc'] ?? 0) - 0.02275)).toBeLessThan(5 * Math.sqrt((0.02275 * 0.97725) / 100000));
    expect((d['comparison'] as Json)['formInsideMonteCarloInterval']).toBe(true);
    expect(itemCodes(d)).toEqual([]);
    expect(d['reviewRequired']).toBe(true);
    expect(d['form']).toBeDefined();
    expect(d['monteCarlo']).toBeDefined();
    expect(d['fosm']).toBeDefined();
    expect(d['sorm']).toBeUndefined();
    expect(result.summary).toContain('form 0.0227501');
  });

  it('runs only the requested methods and shows SORM when asked', () => {
    const quadratic = modelDoc([normal('u1', 0, 1), normal('u2', 0, 1)], '3 - u1 + 0.1 * pow(u2, 2)');
    const d = data(study(quadratic, { methods: ['sorm'] }));
    expect(d['sorm']).toBeDefined();
    expect(d['form']).toBeUndefined();
    expect(d['monteCarlo']).toBeUndefined();
    const pf = (d['comparison'] as { pf: Record<string, number> }).pf;
    expect(relative(pf['sorm'] ?? 0, 1.06718809723e-3)).toBeLessThan(1e-6);
    expect((d['comparison'] as Json)['formInsideMonteCarloInterval']).toBeNull();
  });

  it('warns PRB_FORM_MC_DISAGREE when FORM falls outside the Monte Carlo interval', () => {
    const curved = modelDoc([normal('u1', 0, 1), normal('u2', 0, 1)], '2 - u1 + 0.5 * pow(u2, 2)');
    const d = data(study(curved, { methods: ['form', 'mc'], samples: 200000, sampling: 'mc' }));
    expect(itemCodes(d)).toContain('PRB_FORM_MC_DISAGREE');
    expect((d['comparison'] as Json)['formInsideMonteCarloInterval']).toBe(false);
  });

  it('refuses Monte Carlo without a seed or above the sample cap, unknown limit states and bad methods', () => {
    const doc = rMinusS();
    const noSeed = execute(doc, 'run_reliability_study', { limitState: 'g', methods: ['mc'] });
    expect(code(noSeed)).toBe('PRB_PARAMS_INVALID');
    expect(noSeed.document).toBe(doc);
    expect(code(study(doc, { samples: 3_000_000 }))).toBe('PRB_BUDGET_EXCEEDED');
    expect(code(study(doc, { limitState: 'nope' }))).toBe('PRB_LIMIT_STATE_NOT_FOUND');
    expect(execute(doc, 'run_reliability_study', { limitState: 'g', methods: ['sobol'] }).summary).toMatch(/rejected/);
    expect(execute(doc, 'run_reliability_study', { limitState: 'g', methods: [] }).summary).toMatch(/rejected/);
    const formOnly = execute(doc, 'run_reliability_study', { limitState: 'g', methods: ['form'] });
    expect(formOnly.affected).toEqual([]);
    expect(code(formOnly)).toBeUndefined();
  });
});
