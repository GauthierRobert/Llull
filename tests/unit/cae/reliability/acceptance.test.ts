/**
 * accept_reliability_result as a human gate (TR-PRB-12): the signature is `confirmation`, never reaches the history, is verified first and spent last,
 * binds the model hash and the document uid, and a replay keeps the acceptance only from the ledger a human really signed.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { acceptancePayload } from '@cae/reliability/acceptance';
import { limitStateModelHash } from '@cae/reliability/modelHash';
import { isRecord } from '@lib/isRecord';
import { code, data, rMinusS } from './support';

const SECRET = 'sig-bytes-prb';
const justification = 'beta 2.0 is accepted for the prototype, covered by the proof test';

/** Accepts only a confirmation made over exactly the payload it carries; each is spendable once, like a real port. */
function port(): HumanSignaturePort & { readonly spentCount: () => number } {
  const spent = new Set<string>();
  return {
    verify: (given, payload) =>
      isRecord(given) && given['secret'] === SECRET && given['payload'] === payload ? { signer: 'alice', signatureId: 'sig-9' } : null,
    spend: (given, payload) => {
      const key = `${JSON.stringify(given)}|${payload}`;
      if (spent.has(key)) return false;
      spent.add(key);
      return true;
    },
    spentCount: () => spent.size,
  };
}
const signedFor = (payload: string): Record<string, unknown> => ({ nonce: 'n1', secret: SECRET, payload });
const ctxWith = (signing: HumanSignaturePort | null): ExecutionContext => ({ ...defaultContext(), humanSignature: signing });

const doc: CadDocument = { ...rMinusS(), uid: 'a'.repeat(32) };
const modelHash = limitStateModelHash(doc, 'g') ?? '';
const params = { limitState: 'g', modelHash, justification };
const payloadOf = (d: CadDocument, hash = modelHash, text = justification): string => acceptancePayload('g', hash, text, d.uid ?? '');
const confirmation = signedFor(payloadOf(doc));
const accept = (
  d: CadDocument,
  extra: Record<string, unknown>,
  signing: HumanSignaturePort | null,
  base = params,
): ReturnType<typeof execute> => execute(d, 'accept_reliability_result', { ...base, ...extra }, ctxWith(signing));
const signed = accept(doc, { confirmation }, port()).document;
const replay = (d: CadDocument, signing: HumanSignaturePort | null): CadDocument =>
  execute(d, 'replay_history', {}, ctxWith(signing)).document;

describe('accept_reliability_result', () => {
  it('records the acceptance with its proof and the document uid; the history and the saved file hold no signature', () => {
    expect(signed.probabilistic?.acceptances?.['g']).toMatchObject({
      modelHash,
      signer: 'alice',
      signatureId: 'sig-9',
      signature: confirmation,
      documentUid: doc.uid,
    });
    expect(signed.probabilistic?.acceptanceLedger).toHaveLength(1);
    const step = signed.featureHistory.at(-1);
    expect(step?.name).toBe('accept_reliability_result');
    expect(JSON.stringify(step?.params)).not.toContain(SECRET);
    expect(JSON.stringify(deserializeDocument(serializeDocument(signed)).featureHistory)).not.toContain(SECRET);
    expect(accept(doc, { confirmation }, port()).summary).toContain("'g' accepted by alice");
  });

  it('is pure and an agent without a signature is refused; a recorded confirmation outside a replay is no signature', () => {
    const before = JSON.stringify(doc);
    for (const result of [
      accept(doc, {}, port()),
      accept(doc, { confirmation: true }, port()),
      accept(doc, { confirmation: { verified: true } }, port()),
      accept(doc, { confirmation }, null),
      execute(doc, 'accept_reliability_result', params, defaultContext()),
      accept(doc, { confirmation: signedFor('0'.repeat(64)) }, port()),
    ]) {
      expect(code(result)).toBe('PRB_HUMAN_GATE');
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('verifies first and spends last: a refusal never burns the signature, a used one is refused', () => {
    const signing = port();
    const wrongHash = accept(doc, { confirmation, modelHash: 'f'.repeat(64) }, signing);
    expect(code(wrongHash)).toBe('PRB_RESULT_STALE');
    expect(accept(doc, { confirmation, limitState: 'nope' }, signing).error?.code).toBe('PRB_LIMIT_STATE_NOT_FOUND');
    expect(accept(doc, { confirmation, justification: ' ' }, signing).error?.code).toBe('PRB_PARAMS_INVALID');
    expect(signing.spentCount()).toBe(0);
    expect(accept(doc, { confirmation }, signing).error).toBeUndefined();
    expect(signing.spentCount()).toBe(1);
    expect(code(accept(doc, { confirmation }, signing))).toBe('PRB_HUMAN_GATE');
  });

  it('refuses a document without a uid (after the port) and binds the signature to this document', () => {
    const { uid, ...bare } = doc;
    void uid;
    const result = accept(bare, { confirmation: signedFor(payloadOf(bare)) }, port());
    expect(code(result)).toBe('PRB_DOCUMENT_UNIDENTIFIED');
    const other: CadDocument = { ...doc, uid: 'f'.repeat(32) };
    expect(code(accept(other, { confirmation }, port()))).toBe('PRB_HUMAN_GATE');
  });

  it('replay_history keeps the acceptance without spending again, with any port or none; so does a reloaded document', () => {
    const signing = port();
    const once = accept(doc, { confirmation }, signing).document;
    const replayed = replay(once, signing);
    expect(replayed.probabilistic?.acceptances?.['g']).toEqual(once.probabilistic?.acceptances?.['g']);
    expect(replayed.probabilistic?.acceptanceLedger).toEqual(once.probabilistic?.acceptanceLedger);
    expect(signing.spentCount()).toBe(1);
    expect(replay(once, port()).probabilistic?.acceptances?.['g']).toBeDefined();
    expect(replay(once, null).probabilistic?.acceptances?.['g']).toBeDefined();
    expect(replay(deserializeDocument(serializeDocument(signed)), null).probabilistic?.acceptances?.['g']).toBeDefined();
  });

  it('a replay drops an acceptance whose ledger entry is forged, from another document or changed', () => {
    const replayWith = (patch: Record<string, unknown>, uid = doc.uid): unknown => {
      const ledger = (signed.probabilistic?.acceptanceLedger ?? []).map((entry) => ({ ...entry, ...patch }));
      const seeded = { ...signed, uid, probabilistic: { ...signed.probabilistic, acceptanceLedger: ledger } } as CadDocument;
      return replay(seeded, port()).probabilistic?.acceptances?.['g'];
    };
    expect(replayWith({})).toBeDefined();
    expect(replayWith({ signature: { ...confirmation, secret: 'forged' } })).toBeUndefined();
    expect(replayWith({ signer: 'mallory' })).toBeUndefined();
    expect(replayWith({ justification: 'other' })).toBeUndefined();
    expect(replayWith({}, 'f'.repeat(32))).toBeUndefined();
    const stripped = { ...signed, probabilistic: { ...signed.probabilistic, acceptanceLedger: [] } } as CadDocument;
    expect(replay(stripped, port()).probabilistic?.acceptances?.['g']).toBeUndefined();
  });

  it('check_probabilistic re-verifies the acceptance: valid, then stale once the model changes, then unverifiable without a port', () => {
    const signing = port();
    const items = (d: CadDocument, s: HumanSignaturePort | null): string[] =>
      (data(execute(d, 'check_probabilistic', { limitState: 'g' }, ctxWith(s)))['items'] as Array<{ code: string }>).map((i) => i.code);
    expect(items(signed, signing)).toContain('PRB_ACCEPTED');
    expect(items(signed, null)).toContain('PRB_HUMAN_GATE');
    const changed = execute(signed, 'define_random_variable', {
      name: 'R',
      unit: 'MPa',
      distribution: { kind: 'normal', mean: 310, sd: 30 },
      citation: { text: 't' },
    }).document;
    expect(items(changed, signing)).toContain('PRB_RESULT_STALE');
    const copied = { ...signed, uid: 'f'.repeat(32) } as CadDocument;
    expect(items(copied, signing)).toContain('PRB_HUMAN_GATE');
  });
});
