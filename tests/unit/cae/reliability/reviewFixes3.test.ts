/** Review round 2: ignored document-bound variables warn, the result hash scope is pinned, a forged ledger is not honoured. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { acceptancePayload } from '@cae/reliability/acceptance';
import { isRecord } from '@lib/isRecord';
import { data, rMinusS, type Json } from './support';
import { massModel } from './responses.support';

const codesOf = (items: unknown): string[] => (items as Array<{ code: string }>).map((i) => i.code);

describe('PRB_VARIABLE_NOT_APPLIED warning on a limit state that reads a response', () => {
  const withModulus = (expression: string): CadDocument => {
    let doc = execute(massModel().doc, 'define_random_variable', {
      name: 'modulus',
      unit: 'MPa',
      binding: { kind: 'materialProperty', material: 'test_al', property: 'E' },
      distribution: { kind: 'normal', mean: 70000, sd: 1000 },
      citation: { text: 'supplier certificate' },
    }).document;
    doc = execute(doc, 'define_limit_state', { name: 'mass_budget', expression, unit: 'g' }).document;
    return doc;
  };

  it('propagate_uncertainty and run_reliability_study list the ignored variable', () => {
    const doc = withModulus('22 - mass');
    const propagated = data(execute(doc, 'propagate_uncertainty', { method: 'lhs', samples: 30, seed: 1 }));
    const items = (propagated['limitStates'] as Record<string, Json>)['mass_budget']?.['items'];
    expect(codesOf(items)).toContain('PRB_VARIABLE_NOT_APPLIED');
    const warning = (items as Array<{ code: string; ids: string[]; severity: string }>).find((i) => i.code === 'PRB_VARIABLE_NOT_APPLIED');
    expect(warning).toMatchObject({ ids: ['modulus'], severity: 'warning' });
    const study = data(execute(doc, 'run_reliability_study', { limitState: 'mass_budget', methods: ['form'] }));
    expect(codesOf((study['form'] as Json)['items'])).toContain('PRB_VARIABLE_NOT_APPLIED');
  });

  it('no warning when the variable is named in the expression, nor when every variable reaches the response', () => {
    const named = data(execute(withModulus('22 - mass + 0 * modulus'), 'propagate_uncertainty', { method: 'lhs', samples: 30, seed: 1 }));
    expect(codesOf((named['limitStates'] as Record<string, Json>)['mass_budget']?.['items'])).not.toContain('PRB_VARIABLE_NOT_APPLIED');
    const plain = data(execute(massModel().doc, 'propagate_uncertainty', { method: 'lhs', samples: 30, seed: 1 }));
    expect(codesOf((plain['limitStates'] as Record<string, Json>)['mass_budget']?.['items'])).not.toContain('PRB_VARIABLE_NOT_APPLIED');
  });
});

describe('the result hash exists only for the reviewable study', () => {
  const doc = rMinusS();
  const run = (extra: Json): ReturnType<typeof execute> =>
    execute(doc, 'run_reliability_study', { limitState: 'g', methods: ['form', 'mc'], seed: 7, samples: 500, ...extra });

  it('reports one for the defaults', () => {
    expect(data(run({}))['resultHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(run({}).summary).not.toContain('No resultHash');
  });

  it.each([
    ['non-lhs sampling', { sampling: 'mc' }],
    ['lhs_centred sampling', { sampling: 'lhs_centred' }],
    ['custom maxIterations', { maxIterations: 50 }],
    ['custom tolerance', { tolerance: 1e-6 }],
  ])('has none, and says why, with %s', (_name, extra) => {
    const result = run(extra);
    expect(data(result)['resultHash']).toBeUndefined();
    expect(result.summary).toContain('No resultHash');
    expect(result.summary).toContain('lhs sampling');
  });
});

describe('a forged ledger entry is not honoured by a replay with a port', () => {
  const SECRET = 'sig-forge';
  const port: HumanSignaturePort = {
    verify: (given, payload) =>
      isRecord(given) && given['secret'] === SECRET && given['payload'] === payload ? { signer: 'alice', signatureId: 'sig-3' } : null,
    spend: () => true,
  };
  const ctx = { ...defaultContext(), humanSignature: port };
  const doc: CadDocument = { ...rMinusS(), uid: 'd'.repeat(32) };
  const resultHash = (
    (data(execute(doc, 'check_probabilistic', { limitState: 'g', seed: 7, samples: 300 }))['limitStates'] as Record<string, Json>)[
      'g'
    ] as Json
  )['resultHash'] as string;
  const params = { limitState: 'g', resultHash, seed: 7, samples: 300, justification: 'reviewed' };
  const payload = acceptancePayload('g', resultHash, 7, 300, 'reviewed', doc.uid ?? '');
  const accepted = execute(doc, 'accept_reliability_result', { ...params, confirmation: { secret: SECRET, payload } }, ctx).document;

  it('replays the genuine acceptance', () => {
    expect(execute(accepted, 'replay_history', {}, ctx).document.probabilistic?.acceptances?.['g']).toBeDefined();
  });

  it.each([
    ['a bogus signature object', { secret: 'bogus', payload }],
    ['a signature over another payload', { secret: SECRET, payload: '0'.repeat(64) }],
    ['a string instead of a signature', 'raw-bytes'],
  ])('drops an entry carrying %s', (_name, signature) => {
    const ledger = (accepted.probabilistic?.acceptanceLedger ?? []).map((entry) => ({ ...entry, signature }));
    const forged = { ...accepted, probabilistic: { ...accepted.probabilistic, acceptanceLedger: ledger } } as CadDocument;
    const replayed = execute(forged, 'replay_history', {}, ctx).document;
    expect(replayed.probabilistic?.acceptances?.['g']).toBeUndefined();
  });
});
