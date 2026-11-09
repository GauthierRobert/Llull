import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { readPointer } from '@cae/reliability/responseEval';
import { reliabilityErrors } from '@cae/reliability/model';
import { code, data, type Json } from './support';
import { boxDoc, massModel } from './responses.support';

const massQuery = (entityId: string, pointer = '/data/mass'): Json => ({ command: 'mass_properties', params: { entityId }, pointer });
describe('readPointer', () => {
  it('walks objects and arrays, decodes ~0 ~1, and refuses what does not resolve', () => {
    const root = { data: { 'a/b': { 'c~d': 3 }, list: [{ v: 7 }] } };
    expect(readPointer(root, '/data/a~1b/c~0d')).toBe(3);
    expect(readPointer(root, '/data/list/0/v')).toBe(7);
    expect(readPointer(root, '/data/missing')).toBeUndefined();
    expect(readPointer(root, 'data')).toBeUndefined();
    expect(readPointer(root, '/data/list/5/v')).toBeUndefined();
  });
});

describe('define_response', () => {
  it('records a response, reports its current value and the id, and replaces by name', () => {
    const { doc, boxId } = boxDoc();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'define_response', { name: 'mass', unit: 'g', query: massQuery(boxId) });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0]).toMatch(/^rs-/);
    expect(result.summary).toContain('current value 21.6 g');
    expect(result.document.probabilistic?.responseOrder).toEqual(['mass']);
    expect(result.document.probabilistic?.responses?.['mass']?.query.pointer).toBe('/data/mass');
    const again = execute(result.document, 'define_response', { name: 'mass', unit: 'kg', query: massQuery(boxId, '/data/massKg') });
    expect(again.document.probabilistic?.responseOrder).toEqual(['mass']);
    expect(again.document.probabilistic?.responses?.['mass']?.unit).toBe('kg');
    expect(again.summary).toContain('Replaced');
    expect(again.summary).toContain('current value 0.0216 kg');
  });

  it('records a response that is not evaluable yet and says why', () => {
    const { doc, boxId } = boxDoc();
    const result = execute(doc, 'define_response', { name: 'mass', unit: 'g', query: massQuery('box-404') });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('not evaluable now');
    const badPointer = execute(doc, 'define_response', { name: 'm', unit: 'g', query: massQuery(boxId, '/data/nothing') });
    expect(badPointer.summary).toContain('not evaluable now');
  });

  it('refuses a mutating or unknown command, a bad pointer, a bad name and a name clash without changing the document', () => {
    const { doc } = boxDoc();
    const withVariable = execute(doc, 'define_random_variable', {
      name: 'v',
      unit: 'mm',
      distribution: { kind: 'normal', mean: 1, sd: 0.1 },
    }).document;
    const refuse = (params: Json, on = doc): string | undefined => {
      const result = execute(on, 'define_response', { name: 'r', unit: 'g', query: massQuery('x'), ...params });
      expect(result.document).toBe(on);
      expect(result.affected).toEqual([]);
      return code(result);
    };
    expect(refuse({ query: { command: 'add_box', params: {}, pointer: '/data/x' } })).toBe('PRB_RESPONSE_NOT_QUERY');
    expect(refuse({ query: { command: 'no_such_command', params: {}, pointer: '/data/x' } })).toBe('PRB_RESPONSE_NOT_QUERY');
    expect(refuse({ query: massQuery('x', 'data/mass') })).toBe('PRB_PARAMS_INVALID');
    expect(refuse({ name: '1bad' })).toBe('PRB_PARAMS_INVALID');
    expect(refuse({ name: 'w' })).toBe('PRB_PARAMS_INVALID');
    expect(refuse({ name: 'pi' })).toBe('PRB_PARAMS_INVALID');
    expect(refuse({ name: 'v' }, withVariable)).toBe('PRB_PARAMS_INVALID');
  });

  it('its slice is validated: a malformed responses table is reported', () => {
    const { doc } = massModel();
    const slice = doc.probabilistic as unknown as Record<string, unknown>;
    expect(reliabilityErrors({ probabilistic: slice })).toEqual([]);
    expect(reliabilityErrors({ probabilistic: { ...slice, responses: { mass: { name: 'mass' } } } })).toEqual([
      "response 'mass' is malformed",
    ]);
    const reserved = { constructor: { ...((slice['responses'] as Record<string, unknown>)['mass'] as object), name: 'constructor' } };
    expect(reliabilityErrors({ probabilistic: { ...slice, responses: reserved, responseOrder: ['constructor'] } })).toEqual([
      "response 'constructor' is malformed",
    ]);
    expect(reliabilityErrors({ probabilistic: { ...slice, responseOrder: ['ghost'] } })).toContain(
      'probabilistic.responseOrder names an unknown response',
    );
    expect(reliabilityErrors({ probabilistic: { ...slice, responses: 'x' } })).toEqual([
      'probabilistic.responses / responseOrder are malformed',
    ]);
  });
});

describe('limit states over a response (VC-PRB-06 d/e)', () => {
  it('propagate_uncertainty gives E[m] = 21.6 g and sd[m] = 0.16200135 g through the registry (regenerating the box)', () => {
    const { doc } = massModel();
    const result = execute(doc, 'propagate_uncertainty', { method: 'lhs', samples: 2000, seed: 7 });
    expect(code(result)).toBeUndefined();
    const stats = (data(result)['limitStates'] as Record<string, Json>)['mass_budget']?.['g'] as Json;
    expect(Math.abs((stats['mean'] as number) - 0.4)).toBeLessThan(0.02);
    expect(Math.abs((stats['sd'] as number) - 0.16200135) / 0.16200135).toBeLessThan(0.05);
  });

  it('FORM beta of 22 - mass is about (22 - 21.6) / sd[m]', () => {
    const { doc } = massModel();
    const form = data(execute(doc, 'run_reliability_study', { limitState: 'mass_budget', methods: ['form'] }))['form'] as Json;
    expect(Math.abs((form['beta'] as number) - 0.4 / 0.16200135)).toBeLessThan(0.15);
    expect(Object.keys(form['designPointX'] as Json)).toEqual(['w_rv', 'h_rv', 'd_rv']);
  });

  it('refuses a response-backed sampling run above 20000 evaluations', () => {
    const { doc } = massModel();
    const result = execute(doc, 'propagate_uncertainty', { method: 'mc', samples: 20001, seed: 1 });
    expect(code(result)).toBe('PRB_BUDGET_EXCEEDED');
    expect(result.document).toBe(doc);
    const study = execute(doc, 'run_reliability_study', { limitState: 'mass_budget', methods: ['mc'], samples: 20001, seed: 1 });
    expect(code(study)).toBe('PRB_BUDGET_EXCEEDED');
  });

  it('a response whose query stops working gives NaN evaluations, never a throw', () => {
    const { doc, boxId } = massModel();
    const broken = execute(doc, 'define_response', { name: 'mass', unit: 'g', query: massQuery(`${boxId}-gone`) }).document;
    const result = execute(broken, 'propagate_uncertainty', { method: 'mc', samples: 20, seed: 1 });
    expect(result.document).toBe(broken);
    const g = (data(result)['limitStates'] as Record<string, Json>)['mass_budget'] as Json;
    expect((g['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('PRB_RESPONSE_FAILED');
    expect(g['failedSamples']).toBe(20);
  });
});
