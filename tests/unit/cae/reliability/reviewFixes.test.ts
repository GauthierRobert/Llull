import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { code, data, modelDoc, normal, type Json } from './support';

const NORMAL = { kind: 'normal', mean: 40, sd: 0.1 };
const define = (doc: Parameters<typeof execute>[0], params: Json): ReturnType<typeof execute> =>
  execute(doc, 'define_random_variable', { unit: 'mm', distribution: NORMAL, ...params });

describe('delete_random_variable and bound parameters (R1)', () => {
  const bound = (): ReturnType<typeof createEmptyDocument> => {
    const withParameter = execute(createEmptyDocument(), 'set_parameter', { name: 'w', expression: '40' }).document;
    const variable = define(withParameter, { name: 'width', binding: { kind: 'parameter', parameter: 'w' } }).document;
    return execute(variable, 'define_limit_state', { name: 'g', expression: '41 - w', unit: 'mm' }).document;
  };

  it('refuses while a limit state references the bound parameter, like the study context does', () => {
    const doc = bound();
    const refused = execute(doc, 'delete_random_variable', { name: 'width' });
    expect(code(refused)).toBe('PRB_EXPRESSION_INVALID');
    expect(refused.document).toBe(doc);
    expect(refused.summary).toContain("bound parameter 'w'");
    expect(execute(doc, 'run_reliability_study', { limitState: 'g', methods: ['fosm'] }).rejected).toBeUndefined();
  });

  it('deletes once no limit state uses the variable or its parameter', () => {
    const withParameter = execute(createEmptyDocument(), 'set_parameter', { name: 'w', expression: '40' }).document;
    const doc = define(withParameter, { name: 'width', binding: { kind: 'parameter', parameter: 'w' } }).document;
    expect(execute(doc, 'delete_random_variable', { name: 'width' }).affected).toHaveLength(1);
  });
});

describe('define_random_variable names (R4)', () => {
  it('refuses the name of a document parameter or a built-in constant', () => {
    const withParameter = execute(createEmptyDocument(), 'set_parameter', { name: 'w', expression: '40' }).document;
    for (const [doc, name] of [
      [withParameter, 'w'],
      [createEmptyDocument(), 'pi'],
      [createEmptyDocument(), 'tau'],
    ] as const) {
      const refused = define(doc, { name });
      expect(code(refused)).toBe('PRB_PARAMS_INVALID');
      expect(refused.document).toBe(doc);
      expect(refused.affected).toEqual([]);
    }
    expect(define(withParameter, { name: 'width' }).affected).toHaveLength(1);
  });
});

describe('run_reliability_study compares only requested methods (R3)', () => {
  const quadratic = modelDoc([normal('u1', 0, 1), normal('u2', 0, 1)], '3 - u1 + 0.1 * pow(u2, 2)');
  const study = (methods: string[]): ReturnType<typeof execute> =>
    execute(quadratic, 'run_reliability_study', { limitState: 'g', methods, seed: 11, samples: 400000, sampling: 'mc' });

  it('SORM with Monte Carlo is not judged by an unrequested FORM (FORM Pf 1.35e-3 lies outside the interval, SORM 1.07e-3 inside)', () => {
    const d = data(study(['sorm', 'mc']));
    expect(d['form']).toBeUndefined();
    expect((d['comparison'] as Json)['formInsideMonteCarloInterval']).toBe(true);
    expect((d['items'] as unknown[]).length).toBe(0);
  });

  it('FORM with Monte Carlo is still compared and flagged', () => {
    const d = data(study(['form', 'mc']));
    expect((d['comparison'] as Json)['formInsideMonteCarloInterval']).toBe(false);
    expect(JSON.stringify(d['items'])).toContain('FORM Pf');
  });
});
