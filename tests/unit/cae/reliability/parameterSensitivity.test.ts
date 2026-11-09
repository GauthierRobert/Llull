import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { code, data, relative, type Json } from './support';
import { boxDoc, massModel } from './responses.support';

interface Row {
  parameter: string;
  value: number;
  unit: string;
  derivative: number;
  derivativeUnit: string;
  elasticity: number | null;
  forward: number;
  backward: number;
  smooth: boolean;
}
const rows = (result: ReturnType<typeof execute>): Row[] => data(result)['rows'] as Row[];

describe('parameter_sensitivity (VC-PRB-06 b/c)', () => {
  it('gives dm/d(w,h,d) = 0.54, 1.08, 2.16 g/mm and unit elasticities for the box mass', () => {
    const { doc } = massModel();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'parameter_sensitivity', { parameters: ['w', 'h', 'd'], response: 'mass' });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const table = rows(result);
    expect(table.map((row) => row.parameter)).toEqual(['w', 'h', 'd']);
    [0.54, 1.08, 2.16].forEach((expected, i) => {
      expect(relative(table[i]?.derivative ?? 0, expected)).toBeLessThan(1e-6);
      expect(Math.abs((table[i]?.elasticity ?? 9) - 1)).toBeLessThan(1e-6);
      expect(table[i]?.smooth).toBe(true);
    });
    expect(table[0]?.value).toBe(40);
    expect(table[0]?.unit).toBe('mm');
    expect(table[0]?.derivativeUnit).toBe('g/mm');
    expect(data(result)['reviewRequired']).toBe(true);
    expect(result.summary).toContain('dmass/dw = 0.54');
  });

  it('works with an inline query, a custom step and the document unit when no variable is bound', () => {
    const { doc, boxId } = boxDoc();
    const result = execute(doc, 'parameter_sensitivity', {
      parameters: ['w'],
      relativeStep: 0.01,
      response: { command: 'mass_properties', params: { entityId: boxId }, pointer: '/data/mass' },
    });
    expect(data(result)['relativeStep']).toBe(0.01);
    expect(rows(result)[0]?.unit).toBe('mm');
    expect(rows(result)[0]?.derivativeUnit).toBe('response unit/mm');
    expect(relative(rows(result)[0]?.derivative ?? 0, 0.54)).toBeLessThan(1e-6);
  });

  it('uses an absolute step for a zero parameter and reports a null elasticity', () => {
    let { doc } = boxDoc();
    doc = execute(doc, 'set_parameter', { name: 'zero', expression: '0' }).document;
    const result = execute(doc, 'parameter_sensitivity', {
      parameters: ['zero'],
      response: { command: 'mass_properties', params: { entityId: 'box-2.1' }, pointer: '/data/mass' },
    });
    expect(rows(result)[0]?.derivative).toBeCloseTo(0, 12);
    expect(rows(result)[0]?.elasticity).toBeNull();
  });

  it('flags a kink: the smallest principal moment switches axis when w crosses h', () => {
    const { doc, boxId } = boxDoc();
    const squared = execute(doc, 'set_parameter', { name: 'w', expression: '20' }).document;
    const result = execute(squared, 'parameter_sensitivity', {
      parameters: ['w'],
      response: { command: 'mass_properties', params: { entityId: boxId }, pointer: '/data/inertia/principal/moments/0' },
    });
    expect(rows(result)[0]?.smooth).toBe(false);
    const items = data(result)['items'] as Array<{ code: string }>;
    expect(items.map((i) => i.code)).toEqual(['PRB_NOT_SMOOTH']);
    expect(result.summary).toContain('PRB_NOT_SMOOTH');
  });

  it('refuses without changing the document', () => {
    const { doc, boxId } = massModel();
    const refuse = (params: Json): string | undefined => {
      const result = execute(doc, 'parameter_sensitivity', { parameters: ['w'], response: 'mass', ...params });
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      return code(result);
    };
    expect(refuse({ parameters: ['nope'] })).toBe('PRB_PARAMETER_NOT_FOUND');
    expect(refuse({ response: 'nope' })).toBe('PRB_RESPONSE_NOT_FOUND');
    expect(refuse({ response: { command: 'mass_properties', params: { entityId: `${boxId}-gone` }, pointer: '/data/mass' } })).toBe(
      'PRB_RESPONSE_FAILED',
    );
    expect(refuse({ relativeStep: 0.9 })).toBe('CMD_INVALID_PARAMS');
    // d - 2 h goes below zero when h is perturbed by -100 %: the box stops regenerating
    const tiny = execute(doc, 'set_parameter', { name: 'w', expression: '1e-9' }).document;
    const huge = execute(tiny, 'parameter_sensitivity', { parameters: ['w'], response: 'mass', relativeStep: 0.5 });
    expect(code(huge) === undefined || code(huge) === 'PRB_RESPONSE_FAILED').toBe(true);
  });
});

describe('sensitivity_indices on a response (VC-PRB-06)', () => {
  it('matches the closed-form Sobol indices of the product model m = rho w h d', () => {
    const { doc } = massModel();
    const result = execute(doc, 'sensitivity_indices', { response: 'mass', samples: 1024, seed: 5, bootstrap: 20 });
    expect(code(result)).toBeUndefined();
    const d = data(result);
    const mu = [40, 20, 10];
    const sd = [0.1, 0.1, 0.05];
    const total = mu.reduce((product, m, i) => product * (m * m + (sd[i] ?? 0) ** 2), 1) - mu.reduce((product, m) => product * m * m, 1);
    const first = mu.map((_, i) => ((sd[i] ?? 0) ** 2 * mu.reduce((product, m, j) => (j === i ? product : product * m * m), 1)) / total);
    ['w_rv', 'h_rv', 'd_rv'].forEach((name, i) => {
      expect(Math.abs(((d['S'] as Record<string, { value: number }>)[name]?.value ?? 9) - (first[i] ?? 0))).toBeLessThan(0.08);
    });
    expect(d['evaluations']).toBe(1024 * 5);
    expect(d['target']).toEqual({ kind: 'response', name: 'mass' });
    expect(d['unit']).toBe('g');
    expect(Math.abs((d['mean'] as number) - 21.6)).toBeLessThan(0.05);
    expect(Math.abs(Math.sqrt(d['variance'] as number) - 0.16200135)).toBeLessThan(0.02);
  });

  it('also analyses a limit state that reads the response', () => {
    const { doc } = massModel();
    const d = data(execute(doc, 'sensitivity_indices', { limitState: 'mass_budget', samples: 128, seed: 5, bootstrap: 0 }));
    expect(Object.keys(d['S'] as Json)).toEqual(['w_rv', 'h_rv', 'd_rv']);
  });

  it('refuses a response without bound inputs, and a response budget above 20000 evaluations', () => {
    const { doc, boxId } = boxDoc();
    const withResponse = execute(doc, 'define_response', {
      name: 'mass',
      unit: 'g',
      query: { command: 'mass_properties', params: { entityId: boxId }, pointer: '/data/mass' },
    }).document;
    const empty = execute(withResponse, 'sensitivity_indices', { response: 'mass', samples: 16, seed: 1 });
    expect(code(empty)).toBe('PRB_MODEL_EMPTY');
    expect(empty.document).toBe(withResponse);
    const over = execute(massModel().doc, 'sensitivity_indices', { response: 'mass', samples: 5000, seed: 1 });
    expect(code(over)).toBe('PRB_BUDGET_EXCEEDED');
  });
});
