/** dispose_fit_result across history, replay, copy and load: the signature never reaches the history; replay keeps only what a human signed (FIX-SIG-DFR). */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';

import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { thermoFixture } from './fixtures';

const ROW = 'hole 20 degC | shaft 20 degC';
const params = { rowKey: ROW, decision: 'accepted', justification: 'checked by hand', inputsHash: 'h1' };
const SECRET = 'sig-bytes-9f3a';
const confirmation = { nonce: 'n1', signature: SECRET };

/** Accepts the one confirmation above; each is spendable once (a second use is refused like a real port). */
function port(): HumanSignaturePort & { readonly spentCount: () => number } {
  const spent = new Set<string>();
  return {
    verify: (given) => (isRecord(given) && given['signature'] === SECRET ? { signer: 'alice', signatureId: 'sig-1' } : null),
    spend: (given) => {
      const key = JSON.stringify(given);
      if (spent.has(key)) return false;
      spent.add(key);
      return true;
    },
    spentCount: () => spent.size,
  };
}
const withPort = (signing: HumanSignaturePort | null): ExecutionContext => ({ ...defaultContext(), humanSignature: signing });

const { doc } = thermoFixture();
const dispose = (document: CadDocument, signing = port()): CadDocument =>
  execute(document, 'dispose_fit_result', { ...params, confirmation }, withPort(signing)).document;
const disposed = (document: CadDocument): unknown => document.analysis?.fitDispositions?.[ROW];

describe('dispose_fit_result: the signature stays out of the record', () => {
  const signed = dispose(doc);

  it('records the disposition with its proof and document uid, and the history step holds no signature', () => {
    expect(disposed(signed)).toMatchObject({ signer: 'alice', signature: confirmation, documentUid: doc.uid });
    const step = signed.featureHistory.at(-1);
    expect(step?.name).toBe('dispose_fit_result');
    expect(step?.params).toMatchObject({ rowKey: ROW, confirmation: { verified: true } });
    expect(JSON.stringify(signed.featureHistory)).not.toContain(SECRET);
    expect(JSON.stringify(deserializeDocument(serializeDocument(signed)).featureHistory)).not.toContain(SECRET);
  });

  it('replay_history keeps the disposition without spending the signature again', () => {
    const signing = port();
    const once = dispose(doc, signing);
    expect(signing.spentCount()).toBe(1);
    const replayed = execute(once, 'replay_history', {}, withPort(signing)).document;
    expect(disposed(replayed)).toEqual(disposed(once));
    expect(replayed.analysis?.fitLedger).toEqual(once.analysis?.fitLedger);
    expect(signing.spentCount()).toBe(1);
    const fresh = execute(once, 'replay_history', {}, withPort(port())).document;
    expect(disposed(fresh)).toEqual(disposed(once));
  });

  it('a saved and reloaded document still replays its disposition', () => {
    const reloaded = deserializeDocument(serializeDocument(signed));
    expect(disposed(execute(reloaded, 'replay_history', {}, withPort(null)).document)).toEqual(disposed(signed));
  });

  it('a replay with no matching ledger entry does not invent a disposition', () => {
    const { fitLedger, ...analysis } = signed.analysis ?? { cases: {}, caseOrder: [] };
    void fitLedger;
    expect(disposed(execute({ ...signed, analysis }, 'replay_history', {}, withPort(port())).document)).toBeUndefined();
    const edited: CadDocument = {
      ...signed,
      featureHistory: signed.featureHistory.map((step) =>
        step.name === 'dispose_fit_result' ? { ...step, params: { ...(step.params as object), decision: 'rejected' } } : step,
      ),
    };
    expect(disposed(execute(edited, 'replay_history', {}, withPort(port())).document)).toBeUndefined();
  });

  it('a recorded confirmation outside a replay is no signature: an agent still gets TMC_HUMAN_GATE', () => {
    const recorded = execute(
      signed,
      'dispose_fit_result',
      { ...params, rowKey: 'other', confirmation: { verified: true } },
      withPort(port()),
    );
    expect(recorded.error?.code).toBe('TMC_HUMAN_GATE');
    const agent = execute(doc, 'dispose_fit_result', params);
    expect(agent.error?.code).toBe('TMC_HUMAN_GATE');
    expect(agent.document).toBe(doc);
  });

  it('a document with another uid loses the disposition on replay (a byte copy keeps its uid by design): the ledger entry names its document', () => {
    const copy: CadDocument = { ...signed, uid: 'f'.repeat(32) };
    expect(disposed(execute(copy, 'replay_history', {}, withPort(port())).document)).toBeUndefined();
  });

  it('refuses a document without uid after the gate, an agent first', () => {
    const { uid, ...bare } = doc;
    void uid;
    expect(execute(bare, 'dispose_fit_result', { ...params, confirmation }, withPort(port())).error?.code).toBe(
      'FEA_DOCUMENT_UNIDENTIFIED',
    );
    expect(execute(bare, 'dispose_fit_result', { ...params, confirmation }, withPort(null)).error?.code).toBe('TMC_HUMAN_GATE');
  });

  it('every refusal leaves the signature unspent (the spend comes last)', () => {
    const signing = port();
    const ctx = withPort(signing);
    const { uid, ...bare } = doc;
    void uid;
    const refusals = [
      execute(bare, 'dispose_fit_result', { ...params, confirmation }, ctx),
      execute(doc, 'dispose_fit_result', { ...params, justification: '  ', confirmation }, ctx),
      execute(doc, 'dispose_fit_result', { ...params, currentInputsHash: 'h2', confirmation }, ctx),
      execute(doc, 'dispose_fit_result', { ...params, fitParams: { hole: 'x' }, confirmation }, ctx),
    ];
    expect(refusals.map((result) => result.rejected)).toEqual([true, true, true, true]);
    expect(signing.spentCount()).toBe(0);
    expect(execute(doc, 'dispose_fit_result', { ...params, confirmation }, ctx).rejected).not.toBe(true);
    expect(signing.spentCount()).toBe(1);
    expect(execute(doc, 'dispose_fit_result', { ...params, confirmation }, ctx).error?.code).toBe('TMC_HUMAN_GATE');
  });

  it('a hand-planted or altered ledger entry does not make a recorded step stick (port installed)', () => {
    const ledger = signed.analysis?.fitLedger ?? [];
    const replayWith = (entry: Record<string, unknown>): unknown =>
      disposed(
        execute(
          { ...signed, analysis: { ...signed.analysis, fitLedger: [{ ...ledger[0], ...entry }] } } as CadDocument,
          'replay_history',
          {},
          withPort(port()),
        ).document,
      );
    expect(replayWith({})).toBeDefined();
    expect(replayWith({ signature: { nonce: 'n1', signature: 'forged' } })).toBeUndefined();
    expect(replayWith({ signature: 'raw' })).toBeUndefined();
  });

  it('load validation rejects malformed dispositions and ledger entries', () => {
    const load = (edit: (analysis: Record<string, unknown>) => void): string => {
      const file = JSON.parse(serializeDocument(signed)) as { document: { analysis: Record<string, unknown> } };
      edit(file.document.analysis);
      return execute(createEmptyDocument(), 'load_document', { json: JSON.stringify(file) }).summary;
    };
    expect(load(() => undefined)).toMatch(/^Loaded document/);
    const ledger = (analysis: Record<string, unknown>): Record<string, unknown>[] => analysis['fitLedger'] as Record<string, unknown>[];
    expect(load((analysis) => (analysis['fitLedger'] = 'x'))).toMatch(/fitLedger must be a list/);
    expect(load((analysis) => delete ledger(analysis)[0]!['rowKey'])).toMatch(/fitLedger\[0\].rowKey must be text/);
    expect(load((analysis) => (ledger(analysis)[0]!['decision'] = 'maybe'))).toMatch(/decision must be one of/);
    expect(load((analysis) => (ledger(analysis)[0]!['signature'] = 'raw'))).toMatch(/signature must be a signature object/);
    expect(load((analysis) => (ledger(analysis)[0]!['documentUid'] = 3))).toMatch(/documentUid must be text/);
    expect(load((analysis) => (analysis['fitDispositions'] = []))).toMatch(/fitDispositions must be a record/);
    expect(load((analysis) => (analysis['fitDispositions'] = { [ROW]: 'x' }))).toMatch(/fitDispositions\['.*'\] is malformed/);
  });
});
