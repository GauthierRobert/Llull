import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { reliabilityOf } from '@cae/reliability/model';
import { code, modelDoc, normal, rMinusS } from './support';

const define = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(doc, 'define_random_variable', params);
const NORMAL = { kind: 'normal', mean: 300, sd: 30 };

describe('define_random_variable', () => {
  it('defines a variable, mints rv- ids and replaces by name without duplicating the order', () => {
    const doc = createEmptyDocument();
    const before = JSON.stringify(doc);
    const first = define(doc, { name: 'R', unit: 'MPa', distribution: NORMAL, citation: { text: 'MMPDS' } });
    expect(JSON.stringify(doc)).toBe(before);
    expect(first.affected).toHaveLength(1);
    expect(first.affected[0]).toMatch(/^rv-/);
    expect(first.summary).toContain('Defined random variable');
    const model = reliabilityOf(first.document);
    expect(model.variableOrder).toEqual(['R']);
    expect(model.variables['R']).toMatchObject({ name: 'R', unit: 'MPa', binding: { kind: 'free' }, distribution: NORMAL });
    const second = define(first.document, { name: 'R', unit: 'MPa', distribution: { kind: 'uniform', min: 1, max: 2 } });
    expect(second.summary).toContain('Replaced');
    expect(reliabilityOf(second.document).variableOrder).toEqual(['R']);
    expect(reliabilityOf(second.document).variables['R']?.distribution.kind).toBe('uniform');
    expect(reliabilityOf(second.document).variables['R']?.citation).toBeUndefined();
  });

  it('accepts a parameter binding to an existing parameter and refuses an unknown one', () => {
    const withParameter = execute(createEmptyDocument(), 'set_parameter', { name: 'w', expression: '40' }).document;
    const ok = define(withParameter, {
      name: 'width',
      unit: 'mm',
      distribution: { kind: 'normal', mean: 40, sd: 0.1 },
      binding: { kind: 'parameter', parameter: 'w' },
    });
    expect(ok.affected).toHaveLength(1);
    const refused = define(createEmptyDocument(), {
      name: 'w',
      unit: 'mm',
      distribution: NORMAL,
      binding: { kind: 'parameter', parameter: 'nope' },
    });
    expect(refused.affected).toEqual([]);
    expect(code(refused)).toBe('PRB_BINDING_UNRESOLVED');
  });

  it('refuses invalid distributions with PRB_DISTRIBUTION_INVALID and leaves the document unchanged (VC-PRB-12)', () => {
    const doc = createEmptyDocument();
    for (const distribution of [
      { kind: 'normal', mean: 100, sd: 0 },
      { kind: 'lognormal', mean: -1, sd: 1 },
      { kind: 'uniform', min: 3, max: 1 },
      { kind: 'weibull', shape: -1, scale: 2 },
    ]) {
      const result = define(doc, { name: 'x', unit: 'MPa', distribution });
      expect(code(result)).toBe('PRB_DISTRIBUTION_INVALID');
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
  });

  it('refuses a name that is not an identifier and unknown distribution kinds', () => {
    const doc = createEmptyDocument();
    expect(code(define(doc, { name: '1 bad', unit: 'MPa', distribution: NORMAL }))).toBe('PRB_PARAMS_INVALID');
    const unknown = define(doc, { name: 'x', unit: 'MPa', distribution: { kind: 'beta', a: 1, b: 2 } });
    expect(unknown.document).toBe(doc);
    expect(unknown.summary).toMatch(/rejected/);
  });
});

describe('delete_random_variable', () => {
  it('deletes a variable and trims it from the correlation', () => {
    const doc = modelDoc([normal('a', 0, 1), normal('b', 0, 1), normal('c', 0, 1)], '1');
    const correlated = execute(doc, 'set_correlation', {
      names: ['a', 'b', 'c'],
      matrix: [
        [1, 0.2, 0.1],
        [0.2, 1, 0.3],
        [0.1, 0.3, 1],
      ],
    }).document;
    const deleted = execute(correlated, 'delete_random_variable', { name: 'b' });
    expect(deleted.affected).toHaveLength(1);
    const model = reliabilityOf(deleted.document);
    expect(model.variableOrder).toEqual(['a', 'c']);
    expect(Object.keys(model.variables)).toEqual(['a', 'c']);
    expect(model.correlation).toEqual({
      names: ['a', 'c'],
      matrix: [
        [1, 0.1],
        [0.1, 1],
      ],
    });
    const last = execute(deleted.document, 'delete_random_variable', { name: 'a' }).document;
    expect(reliabilityOf(last).correlation).toBeUndefined();
  });

  it('refuses an unknown variable and one a limit state still uses', () => {
    const doc = rMinusS();
    expect(code(execute(doc, 'delete_random_variable', { name: 'nope' }))).toBe('PRB_VARIABLE_NOT_FOUND');
    const used = execute(doc, 'delete_random_variable', { name: 'R' });
    expect(code(used)).toBe('PRB_EXPRESSION_INVALID');
    expect(used.document).toBe(doc);
  });
});

describe('set_correlation', () => {
  const doc = modelDoc([normal('a', 0, 1), normal('b', 0, 1)], 'a + b');

  it('stores a valid matrix', () => {
    const result = execute(doc, 'set_correlation', {
      names: ['a', 'b'],
      matrix: [
        [1, 0.5],
        [0.5, 1],
      ],
    });
    expect(result.affected).toHaveLength(2);
    expect(reliabilityOf(result.document).correlation).toEqual({
      names: ['a', 'b'],
      matrix: [
        [1, 0.5],
        [0.5, 1],
      ],
    });
  });

  it('refuses a coefficient above 1 (VC-PRB-12), asymmetry, a bad diagonal, wrong size and duplicates', () => {
    const cases: Array<number[][]> = [
      [
        [1, 1.2],
        [1.2, 1],
      ],
      [
        [1, 0.2],
        [0.3, 1],
      ],
      [
        [2, 0],
        [0, 1],
      ],
      [[1]],
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    ];
    for (const matrix of cases) {
      const result = execute(doc, 'set_correlation', { names: ['a', 'b'], matrix });
      expect(code(result)).toBe('PRB_CORRELATION_INVALID');
      expect(result.document).toBe(doc);
    }
    expect(
      code(
        execute(doc, 'set_correlation', {
          names: ['a', 'a'],
          matrix: [
            [1, 0],
            [0, 1],
          ],
        }),
      ),
    ).toBe('PRB_CORRELATION_INVALID');
  });

  it('refuses a matrix that is not positive definite and unknown variables', () => {
    const three = modelDoc([normal('a', 0, 1), normal('b', 0, 1), normal('c', 0, 1)], 'a');
    const notSpd = execute(three, 'set_correlation', {
      names: ['a', 'b', 'c'],
      matrix: [
        [1, 0.9, -0.9],
        [0.9, 1, 0.9],
        [-0.9, 0.9, 1],
      ],
    });
    expect(code(notSpd)).toBe('PRB_CORRELATION_INVALID');
    expect(
      code(
        execute(doc, 'set_correlation', {
          names: ['a', 'zz'],
          matrix: [
            [1, 0],
            [0, 1],
          ],
        }),
      ),
    ).toBe('PRB_VARIABLE_NOT_FOUND');
  });
});

describe('define_limit_state', () => {
  it('defines, replaces and records targets', () => {
    const base = modelDoc([normal('R', 300, 30), normal('S', 200, 40)], 'R - S');
    const model = reliabilityOf(base);
    expect(model.limitStateOrder).toEqual(['g']);
    expect(model.limitStates['g']).toMatchObject({ expression: 'R - S', unit: 'MPa' });
    const targeted = execute(base, 'define_limit_state', {
      name: 'g',
      expression: 'R - 1.5 * S',
      unit: 'MPa',
      targetBeta: { value: 3, source: 'owner' },
      targetPf: { value: 1e-3, source: 'owner' },
    });
    expect(targeted.summary).toContain('Replaced');
    expect(targeted.affected[0]).toMatch(/^ls-/);
    expect(reliabilityOf(targeted.document).limitStateOrder).toEqual(['g']);
    expect(reliabilityOf(targeted.document).limitStates['g']?.targetBeta).toEqual({ value: 3, source: 'owner' });
  });

  it('may use document parameters and pi', () => {
    const withParameter = execute(createEmptyDocument(), 'set_parameter', { name: 'area', expression: '10' }).document;
    const doc = modelDoc([normal('F', 1, 0.1)], 'area - F * pi', {}, withParameter);
    expect(reliabilityOf(doc).limitStateOrder).toEqual(['g']);
  });

  it('refuses syntax errors, unknown symbols, bad names and bad targets', () => {
    const base = modelDoc([normal('R', 300, 30)], 'R');
    const attempt = (params: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(base, 'define_limit_state', { name: 'h', unit: 'MPa', expression: 'R', ...params });
    expect(code(attempt({ expression: 'R +' }))).toBe('PRB_EXPRESSION_INVALID');
    expect(code(attempt({ expression: 'R ^ 2' }))).toBe('PRB_EXPRESSION_INVALID');
    expect(code(attempt({ expression: 'R - Q' }))).toBe('PRB_EXPRESSION_INVALID');
    expect(code(attempt({ name: '9h' }))).toBe('PRB_PARAMS_INVALID');
    expect(code(attempt({ targetBeta: { value: -1, source: 'owner' } }))).toBe('PRB_TARGET_INVALID');
    expect(code(attempt({ targetPf: { value: 1.5, source: 'owner' } }))).toBe('PRB_TARGET_INVALID');
    expect(code(attempt({ targetBeta: { value: 3, source: ' ' } }))).toBe('PRB_TARGET_INVALID');
    const refused = attempt({ expression: 'eval(1)' });
    expect(refused.document).toBe(base);
    expect(refused.affected).toEqual([]);
  });

  it('does not evaluate arbitrary code', () => {
    const base = modelDoc([normal('R', 300, 30)], 'R');
    const result = execute(base, 'define_limit_state', { name: 'h', unit: '1', expression: 'constructor.constructor("return 1")()' });
    expect(result.affected).toEqual([]);
  });
});

describe('persistence', () => {
  it('round-trips the model through save and load', () => {
    const doc = execute(rMinusS({ targetBeta: { value: 3, source: 'owner' } }), 'set_correlation', {
      names: ['R', 'S'],
      matrix: [
        [1, 0.3],
        [0.3, 1],
      ],
    }).document;
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(reliabilityOf(loaded)).toEqual(reliabilityOf(doc));
    expect(serializeDocument(loaded)).toBe(serializeDocument(doc));
  });

  it('rejects a file whose reliability slice is broken', () => {
    const envelope = JSON.parse(serializeDocument(rMinusS())) as { document: { probabilistic: Record<string, unknown> } };
    const broken = (patch: (slice: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
      patch(copy.document.probabilistic);
      return JSON.stringify(copy);
    };
    expect(() =>
      deserializeDocument(broken((s) => ((s['variables'] as Record<string, { distribution: { sd: number } }>)['R']!.distribution.sd = 0))),
    ).toThrow(/random variable 'R'/);
    expect(() => deserializeDocument(broken((s) => (s['variables'] = 5)))).toThrow(/malformed/);
    expect(() => deserializeDocument(broken((s) => (s['limitStates'] = [])))).toThrow(/malformed/);
    expect(() => deserializeDocument(broken((s) => (s['variableOrder'] = ['ghost'])))).toThrow(/unknown variable/);
    expect(() =>
      deserializeDocument(broken((s) => ((s['limitStates'] as Record<string, { expression: unknown }>)['g']!.expression = 4))),
    ).toThrow(/limit state 'g'/);
    const notObject = JSON.parse(JSON.stringify(envelope)) as { document: { probabilistic: unknown } };
    notObject.document.probabilistic = 3;
    expect(() => deserializeDocument(JSON.stringify(notObject))).toThrow(/probabilistic must be an object/);
  });
});
