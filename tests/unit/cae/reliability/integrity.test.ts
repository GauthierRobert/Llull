import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { reliabilityOf } from '@cae/reliability/model';
import { code, data, lognormal, modelDoc, normal, relative, rMinusS, type Json } from './support';

const CORRELATION = {
  names: ['R', 'S'],
  matrix: [
    [1, 0.5],
    [0.5, 1],
  ],
};
const formData = (doc: CadDocument): Json =>
  data(execute(doc, 'run_reliability_study', { limitState: 'g', methods: ['form'] }))['form'] as Json;
const correlated = (): CadDocument => execute(rMinusS(), 'set_correlation', CORRELATION).document;

const COMMANDS: Array<[string, Json, boolean]> = [
  ['define_random_variable', { name: 'T', unit: 'K', distribution: { kind: 'normal', mean: 1, sd: 0.1 } }, false],
  ['delete_random_variable', { name: 'U' }, false],
  ['set_correlation', CORRELATION, false],
  ['define_limit_state', { name: 'h', expression: 'R - S', unit: 'MPa' }, false],
  ['run_reliability_study', { limitState: 'g', methods: ['form', 'sorm'] }, true],
  ['propagate_uncertainty', { limitState: 'g', method: 'mc', samples: 200, seed: 1 }, true],
  ['run_reliability_study', { limitState: 'g', seed: 1, samples: 200 }, true],
];

describe('is pure', () => {
  it.each(COMMANDS)('%s does not mutate its input document', (name, params, readOnly) => {
    const doc = execute(rMinusS(), 'define_random_variable', {
      name: 'U',
      unit: '1',
      distribution: { kind: 'normal', mean: 0, sd: 1 },
    }).document;
    const before = JSON.parse(JSON.stringify(doc)) as unknown;
    const result = execute(doc, name, params);
    expect(doc).toEqual(before);
    if (readOnly) expect(result.document).toBe(doc);
    else expect(result.document).not.toBe(doc);
  });

  it('refused calls also return the unchanged input', () => {
    const doc = rMinusS();
    for (const [name, params] of [
      ['run_reliability_study', { limitState: 'nope' }],
      ['delete_random_variable', { name: 'nope' }],
    ] as const)
      expect(execute(doc, name, params).document).toBe(doc);
  });
});

describe('clear_document', () => {
  it('drops the probabilistic slice and is not a no-op for a document holding only that slice', () => {
    const doc = rMinusS();
    expect(doc.entities).toEqual({});
    const cleared = execute(doc, 'clear_document', {});
    expect(cleared.summary).not.toBe('Document is already empty.');
    expect(cleared.document.probabilistic).toBeUndefined();
    expect(reliabilityOf(cleared.document).variableOrder).toEqual([]);
  });
});

describe('total sampling budget', () => {
  it('refuses 2 limit states x 1.5e6 samples in propagate_uncertainty and run_reliability_study keeps its own cap', () => {
    const two = execute(rMinusS(), 'define_limit_state', { name: 'h', expression: 'R - 2 * S', unit: 'MPa' }).document;
    const refused = execute(two, 'propagate_uncertainty', { method: 'mc', samples: 1_500_000, seed: 1 });
    expect(code(refused)).toBe('PRB_BUDGET_EXCEEDED');
    expect(refused.document).toBe(two);
    expect(refused.summary).toContain('2 limit state');
  });

  it('refuses samples x variables above the memory cap', () => {
    const many = modelDoc(
      Array.from({ length: 11 }, (_, i) => normal(`v${i}`, 0, 1)),
      'v0 + v1',
    );
    const refused = execute(many, 'propagate_uncertainty', { limitState: 'g', method: 'lhs', samples: 1_900_000, seed: 1 });
    expect(code(refused)).toBe('PRB_BUDGET_EXCEEDED');
    expect(refused.summary).toContain('memory cap');
    const study = execute(many, 'run_reliability_study', { limitState: 'g', methods: ['mc'], samples: 1_900_000, seed: 1 });
    expect(code(study)).toBe('PRB_BUDGET_EXCEEDED');
  });

  it('bounds the seed to an unsigned 32-bit integer', () => {
    const doc = rMinusS();
    expect(execute(doc, 'propagate_uncertainty', { method: 'mc', seed: -1 }).summary).toMatch(/rejected/);
    expect(execute(doc, 'propagate_uncertainty', { method: 'mc', seed: 2 ** 32 }).summary).toMatch(/rejected/);
    expect(code(execute(doc, 'propagate_uncertainty', { method: 'mc', seed: 2 ** 32 - 1, samples: 100 }))).toBeUndefined();
  });
});

describe('importance factors under correlation', () => {
  it('give [0.36, 0.64] for R - S with rho = 0.5, as for independent normals', () => {
    const importance = formData(correlated())['importance'] as Record<string, number>;
    expect(importance['R']).toBeCloseTo(0.36, 6);
    expect(importance['S']).toBeCloseTo(0.64, 6);
    expect(Object.values(importance).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
  });

  it('sum to 1 for correlated lognormals and keep the u-space alpha', () => {
    const doc = execute(modelDoc([lognormal('R', 300, 30), lognormal('S', 200, 40)], 'R - S'), 'set_correlation', CORRELATION).document;
    const d = formData(doc);
    const importance = d['importance'] as Record<string, number>;
    expect(importance['R']! + importance['S']!).toBeCloseTo(1, 10);
    expect((d['alphaU'] as number[]).length).toBe(2);
  });
});

describe('parameter bindings', () => {
  const withWidth = (): CadDocument => execute(createEmptyDocument(), 'set_parameter', { name: 'w', expression: '40' }).document;
  const bound = (): CadDocument => {
    const doc = execute(withWidth(), 'define_random_variable', {
      name: 'width',
      unit: 'mm',
      distribution: { kind: 'normal', mean: 40, sd: 2 },
      binding: { kind: 'parameter', parameter: 'w' },
      citation: { text: 'test' },
    }).document;
    return execute(doc, 'define_limit_state', { name: 'g', expression: '38 - 1 * w', unit: 'mm' }).document;
  };

  it('samples the bound parameter: the limit state sees the random value', () => {
    const d = formData(bound());
    // g = 38 - w, w ~ N(40, 2): beta = (38 - 40) / 2 = -1, i.e. the origin already fails.
    expect(relative(d['beta'] as number, -1)).toBeLessThan(1e-6);
    expect(d['variables']).toEqual(['width']);
  });

  it('refuses with PRB_BINDING_UNRESOLVED when the parameter has been deleted', () => {
    const doc = bound();
    const parameters = Object.fromEntries(Object.entries(doc.parameters).filter(([name]) => name !== 'w'));
    const result = execute({ ...doc, parameters }, 'run_reliability_study', { limitState: 'g', methods: ['form'] });
    expect(code(result)).toBe('PRB_BINDING_UNRESOLVED');
  });
});

describe('run_reliability_study', () => {
  it('writes both form and sorm data for ["form", "sorm"]', () => {
    const quadratic = modelDoc([normal('u1', 0, 1), normal('u2', 0, 1)], '3 - u1 + 0.1 * pow(u2, 2)');
    const d = data(execute(quadratic, 'run_reliability_study', { limitState: 'g', methods: ['form', 'sorm'] }));
    expect(d['form']).toBeDefined();
    expect(d['sorm']).toBeDefined();
    expect(Object.keys((d['comparison'] as { pf: Json }).pf)).toEqual(['form', 'sorm']);
  });
});

describe('persistence of malformed probabilistic slices', () => {
  const envelope = JSON.parse(serializeDocument(correlated())) as { document: { probabilistic: Record<string, unknown> } };
  const load = (patch: (slice: Record<string, unknown>) => void): (() => unknown) => {
    const copy = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
    patch(copy.document.probabilistic);
    return () => deserializeDocument(JSON.stringify(copy));
  };
  const variable = (s: Record<string, unknown>): Record<string, unknown> =>
    (s['variables'] as Record<string, Record<string, unknown>>)['R'] ?? {};

  it('accepts the untouched slice', () => {
    expect(load(() => undefined)).not.toThrow();
  });

  it.each([
    [
      'unknown correlation name',
      (s: Record<string, unknown>) => ((s['correlation'] as { names: string[] }).names = ['R', 'Z']),
      /correlation/,
    ],
    [
      'non-square matrix',
      (s: Record<string, unknown>) => ((s['correlation'] as { matrix: number[][] }).matrix = [[1, 0.5]]),
      /correlation/,
    ],
    [
      'asymmetric matrix',
      (s: Record<string, unknown>) =>
        ((s['correlation'] as { matrix: number[][] }).matrix = [
          [1, 0.5],
          [0.4, 1],
        ]),
      /correlation/,
    ],
    [
      'non-unit diagonal',
      (s: Record<string, unknown>) =>
        ((s['correlation'] as { matrix: number[][] }).matrix = [
          [2, 0.5],
          [0.5, 1],
        ]),
      /correlation/,
    ],
    [
      'not positive definite',
      (s: Record<string, unknown>) =>
        ((s['correlation'] as { matrix: number[][] }).matrix = [
          [1, 1],
          [1, 1],
        ]),
      /correlation/,
    ],
    ['correlation not an object', (s: Record<string, unknown>) => (s['correlation'] = 4), /correlation/],
    ['limitStateOrder with a ghost', (s: Record<string, unknown>) => (s['limitStateOrder'] = ['ghost']), /limitStateOrder/],
    ['malformed binding', (s: Record<string, unknown>) => (variable(s)['binding'] = { kind: 'parameter' }), /binding/],
    ['unknown binding kind', (s: Record<string, unknown>) => (variable(s)['binding'] = { kind: 'materialProperty' }), /binding/],
    ['malformed citation', (s: Record<string, unknown>) => (variable(s)['citation'] = { url: 'x' }), /citation/],
    ['missing id', (s: Record<string, unknown>) => delete variable(s)['id'], /random variable 'R'/],
    ['no distribution', (s: Record<string, unknown>) => delete variable(s)['distribution'], /distribution/],
  ])('rejects %s', (_label, patch, message) => {
    expect(load(patch)).toThrow(message);
  });
});

describe('replay', () => {
  it('re-mints identical rv- and ls- ids when the history is replayed or a step is edited', () => {
    const doc = rMinusS();
    const ids = (d: CadDocument): string[] => [
      ...Object.values(reliabilityOf(d).variables).map((v) => v.id),
      ...Object.values(reliabilityOf(d).limitStates).map((l) => l.id),
    ];
    expect(ids(doc).every((id) => /^(rv|ls)-/.test(id))).toBe(true);
    const replayed = execute(doc, 'replay_history', {});
    expect(ids(replayed.document)).toEqual(ids(doc));
    const stepId = doc.featureHistory[0]?.id ?? '';
    const edited = execute(doc, 'edit_step_params', {
      stepId,
      params: { name: 'R', unit: 'MPa', distribution: { kind: 'normal', mean: 320, sd: 30 }, citation: { text: 'test input' } },
    });
    expect(edited.document).not.toBe(doc);
    expect(ids(edited.document)).toEqual(ids(doc));
    expect(reliabilityOf(edited.document).variables['R']?.distribution).toEqual({ kind: 'normal', mean: 320, sd: 30 });
  });
});
