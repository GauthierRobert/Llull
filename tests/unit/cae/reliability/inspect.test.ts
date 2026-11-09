import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { reliabilityErrors } from '@cae/reliability/model';
import { code, data, modelDoc, normal, rMinusS, type Json } from './support';

const itemCodes = (d: Json): string[] => (d['items'] as Array<{ code: string }>).map((i) => i.code);

describe('describe_probabilistic_model', () => {
  it('lists variables with resolved moments, limit states with a model hash, and flags unsourced scatter', () => {
    const doc = modelDoc([normal('R', 300, 30), normal('S', 200, 40, false)], 'R - S', { targetBeta: { value: 3, source: 'owner' } });
    const result = execute(doc, 'describe_probabilistic_model', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const d = data(result);
    const variables = d['variables'] as Array<Json>;
    expect(variables.map((v) => v['name'])).toEqual(['R', 'S']);
    expect(variables[0]).toMatchObject({ mean: 300, sd: 30, unit: 'MPa', unverified: false });
    expect(variables[1]?.['unverified']).toBe(true);
    expect(d['unverified']).toEqual(['S']);
    const limitStates = d['limitStates'] as Array<Json>;
    expect(limitStates[0]).toMatchObject({ name: 'g', expression: 'R - S', targetBeta: { value: 3, source: 'owner' }, acceptance: null });
    expect(limitStates[0]?.['modelHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(d['reviewRequired']).toBe(true);
    expect(result.summary).toContain('2 random variable(s)');
    expect(result.summary).toContain('unsourced scatter: S');
  });

  it('describes an empty model as empty, and the model hash moves with the model', () => {
    const empty = data(execute(createEmptyDocument(), 'describe_probabilistic_model', {}));
    expect(empty['variables']).toEqual([]);
    expect(empty['limitStates']).toEqual([]);
    const hashOf = (mean: number): unknown =>
      ((
        data(execute(modelDoc([normal('R', mean, 30), normal('S', 200, 40)], 'R - S'), 'describe_probabilistic_model', {}))[
          'limitStates'
        ] as Json[]
      )[0] ?? {})['modelHash'];
    expect(hashOf(300)).toBe(hashOf(300));
    expect(hashOf(300)).not.toBe(hashOf(301));
  });

  it('its slice validation rejects a malformed acceptance or ledger', () => {
    const slice = rMinusS().probabilistic as unknown as Record<string, unknown>;
    const acceptance = { modelHash: 'h', justification: 'j', signer: 's', signatureId: 'i', documentUid: 'u', signature: {} };
    expect(reliabilityErrors({ probabilistic: { ...slice, acceptances: { g: acceptance } } })).toEqual([]);
    expect(reliabilityErrors({ probabilistic: { ...slice, acceptances: { ghost: acceptance } } })).toHaveLength(1);
    expect(reliabilityErrors({ probabilistic: { ...slice, acceptances: { g: { ...acceptance, signer: 3 } } } })).toHaveLength(1);
    expect(reliabilityErrors({ probabilistic: { ...slice, acceptances: [] } })).toHaveLength(1);
    expect(reliabilityErrors({ probabilistic: { ...slice, acceptanceLedger: [{ ...acceptance, limitState: 'g' }] } })).toEqual([]);
    expect(reliabilityErrors({ probabilistic: { ...slice, acceptanceLedger: [acceptance] } })).toEqual([
      'probabilistic.acceptanceLedger is malformed',
    ]);
  });
});

describe('check_probabilistic', () => {
  it('warns for an unset target and unsourced scatter, passes a met target, fails a missed one', () => {
    const unset = data(execute(modelDoc([normal('R', 300, 30), normal('S', 200, 40, false)], 'R - S'), 'check_probabilistic', {}));
    expect(unset['status']).toBe('warn');
    expect(itemCodes(unset)).toEqual(expect.arrayContaining(['PRB_SCATTER_UNSOURCED', 'PRB_TARGET_UNSET']));
    const met = data(execute(rMinusS({ targetBeta: { value: 1.5, source: 'owner' } }), 'check_probabilistic', {}));
    expect(met['status']).toBe('pass');
    expect((met['limitStates'] as Record<string, Json>)['g']?.['beta']).toBeCloseTo(100 / 50, 6);
    const missed = execute(rMinusS({ targetBeta: { value: 3, source: 'owner' } }), 'check_probabilistic', {});
    expect(data(missed)['status']).toBe('fail');
    expect(itemCodes(data(missed))).toContain('PRB_TARGET_NOT_MET');
    expect(missed.summary).toContain('fail');
  });

  it('runs Monte Carlo only with a seed and reports PRB_MC_NOT_CONVERGED above the CoV limit and PRB_PF_BELOW_RESOLUTION without failures', () => {
    const doc = rMinusS({ targetBeta: { value: 1, source: 'owner' } });
    expect(itemCodes(data(execute(doc, 'check_probabilistic', {})))).not.toContain('PRB_MC_NOT_CONVERGED');
    const few = data(execute(doc, 'check_probabilistic', { seed: 3, samples: 200 }));
    expect(itemCodes(few)).toContain('PRB_MC_NOT_CONVERGED');
    const lax = data(execute(doc, 'check_probabilistic', { seed: 3, samples: 200, mcPfCovLimit: 5 }));
    expect(itemCodes(lax)).not.toContain('PRB_MC_NOT_CONVERGED');
    const safe = modelDoc([normal('R', 300, 1)], 'R - 100', { targetBeta: { value: 3, source: 'owner' } });
    expect(itemCodes(data(execute(safe, 'check_probabilistic', { seed: 3, samples: 100 })))).toContain('PRB_PF_BELOW_RESOLUTION');
  });

  it('turns a limit state that cannot be studied into an error item, and refuses an unknown or absent limit state', () => {
    const doc = execute(rMinusS(), 'define_limit_state', { name: 'k', expression: 'R + 1', unit: 'MPa' }).document;
    const broken = { ...doc, probabilistic: { ...doc.probabilistic, variables: {}, variableOrder: [] } } as typeof doc;
    const checked = execute(broken, 'check_probabilistic', { limitState: 'k' });
    expect(data(checked)['status']).toBe('fail');
    expect(itemCodes(data(checked))).toContain('PRB_EXPRESSION_INVALID');
    const missing = execute(doc, 'check_probabilistic', { limitState: 'nope' });
    expect(code(missing)).toBe('PRB_LIMIT_STATE_NOT_FOUND');
    expect(missing.document).toBe(doc);
    const empty = createEmptyDocument();
    expect(code(execute(empty, 'check_probabilistic', {}))).toBe('PRB_MODEL_EMPTY');
  });

  it('is pure and reports reviewRequired', () => {
    const doc = rMinusS();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'check_probabilistic', {});
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(data(result)['reviewRequired']).toBe(true);
  });
});
