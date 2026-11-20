/**
 * PRB-b: an acceptance binds the result hash of ANY run_reliability_study method set and options (importance sampling, SORM, custom FORM limits, non-lhs sampling,
 * FOSM): unchanged it stays PRB_ACCEPTED, any changed option is refused at acceptance and makes a stored acceptance PRB_RESULT_STALE.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { acceptancePayload } from '@cae/reliability/acceptance';
import { DEFAULT_STUDY, studyDigest } from '@cae/reliability/resultHash';
import { isRecord } from '@lib/isRecord';
import { code, data, rMinusS, type Json } from './support';
import { massModel } from './responses.support';

const SECRET = 'sig-prb-b';
const port: HumanSignaturePort = {
  verify: (given, payload) =>
    isRecord(given) && given['secret'] === SECRET && given['payload'] === payload ? { signer: 'alice', signatureId: 'sig-b' } : null,
  spend: () => true,
};
const ctx: ExecutionContext = { ...defaultContext(), humanSignature: port };
const doc: CadDocument = { ...rMinusS(), uid: 'e'.repeat(32) };
const JUSTIFICATION = 'reviewed for PRB-b';

/** The study run_reliability_study reports for `options`, with its hash: exactly what the reviewer is handed. */
function studied(d: CadDocument, options: Json): { resultHash: string; study: Json } {
  const result = data(execute(d, 'run_reliability_study', { limitState: 'g', ...options }));
  return { resultHash: result['resultHash'] as string, study: result['resultStudy'] as Json };
}

function accept(d: CadDocument, resultHash: string, study: Json): ReturnType<typeof execute> {
  const seed = typeof study['seed'] === 'number' ? study['seed'] : 0;
  const samples = typeof study['samples'] === 'number' ? study['samples'] : 10_000;
  const payload = acceptancePayload('g', resultHash, seed, samples, JUSTIFICATION, d.uid ?? '');
  return execute(
    d,
    'accept_reliability_result',
    { limitState: 'g', resultHash, justification: JUSTIFICATION, ...study, confirmation: { secret: SECRET, payload } },
    ctx,
  );
}

const checkCodes = (d: CadDocument): string[] =>
  (data(execute(d, 'check_probabilistic', { limitState: 'g' }, ctx))['items'] as Array<{ code: string }>).map((i) => i.code);

/** The stored acceptance with its study patched (an edited file). */
function withStudy(d: CadDocument, patch: Json): CadDocument {
  const accepted = d.probabilistic?.acceptances?.['g'];
  if (accepted === undefined) throw new Error('no acceptance');
  const study = { ...(accepted.study ?? { methods: [] }), ...patch };
  return { ...d, probabilistic: { ...d.probabilistic, acceptances: { g: { ...accepted, study } } } } as CadDocument;
}

const CASES: ReadonlyArray<readonly [string, Json, Json]> = [
  ['importance sampling', { methods: ['is'], seed: 11, samples: 400 }, { samples: 401 }],
  ['importance sampling (seed)', { methods: ['is'], seed: 11, samples: 400 }, { seed: 12 }],
  ['SORM', { methods: ['sorm'] }, { tolerance: 1e-6 }],
  ['form + sorm + is', { methods: ['form', 'sorm', 'is'], seed: 3, samples: 300 }, { maxIterations: 40 }],
  ['custom maxIterations', { methods: ['form', 'mc'], seed: 7, samples: 300, maxIterations: 50 }, { maxIterations: 51 }],
  ['custom tolerance', { methods: ['form'], tolerance: 1e-6 }, { tolerance: 1e-7 }],
  ['plain mc sampling', { methods: ['mc'], seed: 5, samples: 300, sampling: 'mc' }, { sampling: 'lhs_centred' }],
  ['lhs_centred sampling', { methods: ['form', 'mc'], seed: 5, samples: 300, sampling: 'lhs_centred' }, { sampling: 'lhs' }],
  ['FOSM', { methods: ['fosm'] }, { methods: ['fosm', 'form'] }],
  ['default run_reliability_study (form, mc, fosm)', { seed: 2, samples: 300 }, { methods: ['form', 'mc'] }],
];

describe.each(CASES)('acceptance of %s', (_name, options, change) => {
  const { resultHash, study } = studied(doc, options);
  const accepted = accept(doc, resultHash, study);

  it('is accepted with the reported study, records it, and stays PRB_ACCEPTED when unchanged (also after save and load)', () => {
    expect(resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(accepted.error).toBeUndefined();
    const { seed, samples, ...rest } = study;
    void seed;
    void samples;
    expect(accepted.document.probabilistic?.acceptances?.['g']?.study).toEqual(rest);
    expect(checkCodes(accepted.document)).toContain('PRB_ACCEPTED');
    expect(checkCodes(deserializeDocument(serializeDocument(accepted.document)))).toContain('PRB_ACCEPTED');
    const replayed = execute(accepted.document, 'replay_history', {}, ctx).document;
    expect(replayed.probabilistic?.acceptances?.['g']).toEqual(accepted.document.probabilistic?.acceptances?.['g']);
  });

  it('refuses the hash with a changed option (PRB_RESULT_STALE, unchanged doc)', () => {
    const refused = accept(doc, resultHash, { ...study, ...change });
    expect(code(refused)).toBe('PRB_RESULT_STALE');
    expect(refused.document).toBe(doc);
  });

  it('a stored acceptance whose study option is changed reads PRB_RESULT_STALE', () => {
    const { seed, samples, ...studyChange } = change;
    const stored = accepted.document.probabilistic?.acceptances?.['g'];
    const edited =
      seed === undefined && samples === undefined
        ? withStudy(accepted.document, studyChange)
        : ({
            ...accepted.document,
            probabilistic: {
              ...accepted.document.probabilistic,
              acceptances: { g: { ...stored, ...(seed === undefined ? {} : { seed }), ...(samples === undefined ? {} : { samples }) } },
            },
          } as unknown as CadDocument);
    const codes = checkCodes(edited);
    expect(codes).not.toContain('PRB_ACCEPTED');
    expect(codes.some((c) => c === 'PRB_RESULT_STALE' || c === 'PRB_HUMAN_GATE')).toBe(true);
    if (seed === undefined && samples === undefined) expect(codes).toContain('PRB_RESULT_STALE');
  });

  it('goes PRB_RESULT_STALE when the model changes', () => {
    const changed = execute(accepted.document, 'define_random_variable', {
      name: 'R',
      unit: 'MPa',
      distribution: { kind: 'normal', mean: 320, sd: 30 },
      citation: { text: 't' },
    }).document;
    expect(checkCodes(changed)).toContain('PRB_RESULT_STALE');
  });
});

describe('acceptance study options', () => {
  it('a sampled study needs its seed (PRB_PARAMS_INVALID); an unsampled one does not', () => {
    const { resultHash, study } = studied(doc, { methods: ['is'], seed: 11, samples: 400 });
    const { seed, ...seedless } = study;
    void seed;
    const payload = acceptancePayload('g', resultHash, 0, 400, JUSTIFICATION, doc.uid ?? '');
    const refused = execute(
      doc,
      'accept_reliability_result',
      { limitState: 'g', resultHash, justification: JUSTIFICATION, ...seedless, confirmation: { secret: SECRET, payload } },
      ctx,
    );
    expect(code(refused)).toBe('PRB_PARAMS_INVALID');
    const form = studied(doc, { methods: ['form'] });
    expect(accept(doc, form.resultHash, form.study).error).toBeUndefined();
  });

  it('the default study keeps the check_probabilistic hash, so older acceptances (no study recorded) still verify', () => {
    const checked = data(execute(doc, 'check_probabilistic', { limitState: 'g', seed: 7, samples: 300 }));
    const hash = ((checked['limitStates'] as Record<string, Json>)['g'] as Json)['resultHash'];
    const run = studied(doc, { methods: ['form', 'mc'], seed: 7, samples: 300 });
    expect(run.resultHash).toBe(hash);
    const accepted = accept(doc, run.resultHash, run.study).document;
    const legacy = accepted.probabilistic?.acceptances?.['g'];
    if (legacy === undefined) throw new Error('no acceptance');
    const { study, ...old } = legacy;
    void study;
    const older = { ...accepted, probabilistic: { ...accepted.probabilistic, acceptances: { g: old } } } as CadDocument;
    expect(checkCodes(older)).toContain('PRB_ACCEPTED');
  });

  it('describe_probabilistic_model reports the accepted study (the default one for an acceptance that records none)', () => {
    const run = studied(doc, { methods: ['sorm'] });
    const accepted = accept(doc, run.resultHash, run.study).document;
    const described = (d: CadDocument): unknown =>
      ((data(execute(d, 'describe_probabilistic_model', {}))['limitStates'] as Json[])[0]?.['acceptance'] as Json)['study'];
    const { seed, samples, ...signedStudy } = run.study;
    expect([seed, samples]).toEqual([0, 10_000]);
    expect(described(accepted)).toEqual(signedStudy);
    const stored = accepted.probabilistic?.acceptances?.['g'];
    if (stored === undefined) throw new Error('no acceptance');
    const { study, ...old } = stored;
    void study;
    const older = { ...accepted, probabilistic: { ...accepted.probabilistic, acceptances: { g: old } } } as CadDocument;
    expect(described(older)).toEqual({ methods: ['form', 'mc'], sampling: 'lhs', maxIterations: 100, tolerance: 1e-8 });
  });

  it('describe_probabilistic_model lists the responses a limit state reads', () => {
    const responses = data(execute(massModel().doc, 'describe_probabilistic_model', {}))['responses'] as Json[];
    expect(responses.length).toBeGreaterThan(0);
    expect(responses[0]).toHaveProperty('query');
  });

  it('a malformed stored study is refused on load', () => {
    const run = studied(doc, { methods: ['sorm'] });
    const accepted = accept(doc, run.resultHash, run.study).document;
    expect(checkCodes(deserializeDocument(serializeDocument(withStudy(accepted, {}))))).toContain('PRB_ACCEPTED');
    for (const study of [
      { methods: [] },
      { methods: ['nope'] },
      { methods: ['mc'], sampling: 'x' },
      { methods: ['form'], maxIterations: 0 },
      { methods: ['form'], maxIterations: 1e6 },
      { methods: ['form'], maxIterations: 1.5 },
      { methods: ['form', 'sorm', 'mc', 'is', 'fosm', 'form'] },
      { methods: ['form'], extra: 1 },
    ])
      expect(() => deserializeDocument(serializeDocument(withStudy(accepted, study)))).toThrow();
    // a file can carry 1e400 (Infinity once parsed): written as text, not through JSON.stringify
    const text = serializeDocument(withStudy(accepted, { methods: ['form'], tolerance: 123.456 })).replace('123.456', '1e400');
    expect(text).toContain('1e400');
    expect(() => deserializeDocument(text)).toThrow();
  });

  it('an out-of-range study edited in memory is never re-run: check_probabilistic reads PRB_RESULT_STALE at once', () => {
    const run = studied(doc, { methods: ['form'] });
    const accepted = accept(doc, run.resultHash, run.study).document;
    for (const patch of [{ maxIterations: 1e15 }, { tolerance: Number.POSITIVE_INFINITY }]) {
      const codes = checkCodes(withStudy(accepted, patch));
      expect(codes).toContain('PRB_RESULT_STALE');
      expect(codes).not.toContain('PRB_ACCEPTED');
    }
  });

  it('the default-study digest is the one of the base commit (pinned literal, computed at c472b51f8)', () => {
    const runs = { pf: { form: 0.0227501, mc: 0.0231 }, beta: 2.0, data: {}, compared: null, interval: null };
    expect(studyDigest('ab'.repeat(32), DEFAULT_STUDY, 7, 2000, runs)).toBe(
      'da0d57a97e3c1986a0573f8d95cdba37cf76a55720d6e72e4c1f8300c96d422d',
    );
  });
});
