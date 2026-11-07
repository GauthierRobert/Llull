/**
 * dispose_margin / dispose_thermal_limit as human gates across history, replay, copy and load (FIX-SIG-REST): the signature is `confirmation` and never
 * reaches the history, is verified first and spent last (once), and a replay keeps the disposition only from a ledger a human really signed.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { marginDispositionPayload } from '@cae/margins/disposition';
import { dispositionPayload } from '@cae/thermal/dispositionGate';
import { isRecord } from '@lib/isRecord';
import { caseIn } from './helpers';
import { marginBar, STAND_IN_MESH } from './marginsFixtures';
import { caseOf, must } from './thermal/fixtures';
import { solvedWall } from './thermal/solved';

const SECRET = 'sig-bytes-5d21';
const justification = 'accepted for the qualification test, covered by the thermostat';

/** Accepts only a confirmation made over exactly the payload it carries; each is spendable once, like a real port. */
function port(): HumanSignaturePort & { readonly spentCount: () => number } {
  const spent = new Set<string>();
  return {
    verify: (given, payload) =>
      isRecord(given) && given['secret'] === SECRET && given['payload'] === payload ? { signer: 'alice', signatureId: 'sig-7' } : null,
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

interface Gate {
  readonly command: string;
  readonly humanGate: string;
  readonly unidentified: string;
  readonly document: CadDocument;
  readonly params: Record<string, unknown>;
  readonly payload: (document: CadDocument) => string;
  readonly baseContext: ExecutionContext;
  /** The disposition stored for the row, or undefined. */
  readonly stored: (document: CadDocument) => unknown;
  readonly refusals: () => readonly Record<string, unknown>[];
  readonly act: string;
  readonly rowKey: string;
}

function marginGate(): Gate {
  const bar = marginBar();
  const query = { ...STAND_IN_MESH };
  const rows = (
    execute(bar.recorded, 'compute_margins', { analysisId: bar.analysisId, ...query }, bar.ctx).data as { rows: Record<string, unknown>[] }
  ).rows;
  const row = rows[0] as { rowId: string; rowKey: string; status: string; ms: number | null };
  const resultsHash = caseIn(bar.recorded, bar.analysisId).results?.resultsHash ?? '';
  const params = { analysisId: bar.analysisId, ...query, rowId: row.rowId, decision: 'accepted', justification };
  return {
    command: 'dispose_margin',
    humanGate: 'FEA_HUMAN_GATE',
    unidentified: 'FEA_DOCUMENT_UNIDENTIFIED',
    document: bar.recorded,
    params,
    baseContext: bar.ctx,
    payload: (document) =>
      marginDispositionPayload(
        bar.analysisId,
        { rowKey: row.rowKey, status: row.status, ms: row.ms, inputHash: analysisInputHash(document, bar.analysisId, 'full') },
        'accepted',
        justification,
        resultsHash,
        document.uid ?? '',
      ),
    stored: (document) => caseIn(document, bar.analysisId).dispositions[row.rowKey],
    refusals: () => [
      { ...params, justification: '   ' },
      { ...params, rowId: 'r99' },
      { ...params, analysisId: 'an-9.9' },
    ],
    act: 'dispose_margin',
    rowKey: row.rowKey,
  };
}

function recordWith(doc: CadDocument, command: string, params: Record<string, unknown>, ctx: ExecutionContext): CommandResult {
  const result = execute(doc, command, params, ctx);
  if (result.rejected === true) throw new Error(`${command}: ${result.summary}`);
  return result;
}

function thermalGate(): Gate {
  let limitId = '';
  const wall = solvedWall({ basis: 'company' }, 1, undefined, (fixture) => {
    const added = must(fixture.doc, 'add_temperature_limit', {
      analysisId: fixture.analysisId,
      name: 'wall max',
      entityId: fixture.boxId,
      max: { value: 150, unit: 'degC' },
      source: { citation: 'test input of this validation case', locator: 'VC-THM-62' },
    });
    limitId = added.affected[0] ?? '';
    return { doc: added.document };
  });
  const rowId = `${limitId}:max`;
  // the mesh and results enter through the recording commands (as in a real run), so a replay of the history re-creates them
  const baseContext: ExecutionContext = { ...defaultContext(), feaArtifacts: wall.port };
  const solvedCase = caseOf(wall.solved, wall.analysisId);
  const meshed = recordWith(wall.doc, 'record_fe_mesh', { analysisId: wall.analysisId, summary: solvedCase.meshSummary }, baseContext);
  const document = recordWith(
    meshed.document,
    'record_fea_results',
    { analysisId: wall.analysisId, summary: solvedCase.results },
    baseContext,
  ).document;
  const params = { analysisId: wall.analysisId, rowId, decision: 'accepted', justification };
  return {
    command: 'dispose_thermal_limit',
    humanGate: 'THM_HUMAN_GATE',
    unidentified: 'THM_DOCUMENT_UNIDENTIFIED',
    document,
    params,
    baseContext,
    payload: (document) => dispositionPayload(wall.analysisId, rowId, 'accepted', justification, wall.resultsHash, document.uid ?? ''),
    stored: (document) => caseOf(document, wall.analysisId).thermal?.dispositions[rowId],
    refusals: () => [
      { ...params, justification: '   ' },
      { ...params, rowId: 'nope:max' },
      { ...params, analysisId: 'an-9.9' },
    ],
    act: 'dispose_thermal_limit',
    rowKey: rowId,
  };
}

describe.each([
  ['dispose_margin', marginGate],
  ['dispose_thermal_limit', thermalGate],
])('%s', (_name, build) => {
  const gate = build();
  const { command, document: doc } = gate;
  const ctxWith = (signing: HumanSignaturePort | null): ExecutionContext => ({ ...gate.baseContext, humanSignature: signing });
  const run = (
    document: CadDocument,
    extra: Record<string, unknown>,
    signing: HumanSignaturePort | null,
    base = gate.params,
  ): CommandResult => execute(document, command, { ...base, ...extra }, ctxWith(signing));
  const confirmation = signedFor(gate.payload(doc));
  const signed = run(doc, { confirmation }, port()).document;
  const replay = (document: CadDocument, signing: HumanSignaturePort | null): CadDocument =>
    execute(document, 'replay_history', {}, ctxWith(signing)).document;
  const ledger = (document: CadDocument): readonly Record<string, unknown>[] =>
    (document.analysis?.dispositionLedger ?? []) as unknown as Record<string, unknown>[];

  it('records the disposition with its proof and the document uid; the history and the saved file hold no signature', () => {
    expect(gate.stored(doc)).toBeUndefined();
    expect(gate.stored(signed)).toMatchObject({ decision: 'accepted', signer: 'alice', signature: confirmation, documentUid: doc.uid });
    expect(ledger(signed)).toEqual([
      expect.objectContaining({ act: gate.act, rowKey: gate.rowKey, signer: 'alice', signature: confirmation, documentUid: doc.uid }),
    ]);
    const step = signed.featureHistory.at(-1);
    expect(step?.name).toBe(command);
    expect(step?.params).toMatchObject({ confirmation: { verified: true } });
    expect(JSON.stringify(signed.featureHistory)).not.toContain(SECRET);
    expect(JSON.stringify(deserializeDocument(serializeDocument(signed)).featureHistory)).not.toContain(SECRET);
  });

  it('spends the signature once, last: refusals burn nothing and a retry is refused', () => {
    const signing = port();
    const { uid, ...bare } = doc;
    void uid;
    const refusals = gate.refusals();
    const results = [
      ...refusals.map((extra) => run(doc, { ...extra, confirmation }, signing, {})),
      run(doc, { confirmation: signedFor('0'.repeat(64)) }, signing),
      run(doc, { confirmation: { ...confirmation, secret: 'forged' } }, signing),
    ];
    expect(results.every((result) => result.rejected === true && result.document === doc)).toBe(true);
    expect(results.slice(-2).map((result) => result.error?.code)).toEqual([gate.humanGate, gate.humanGate]);
    expect(signing.spentCount()).toBe(0);
    const uidless = execute(bare, command, { ...gate.params, confirmation: signedFor(gate.payload(bare)) }, ctxWith(signing));
    expect(uidless.error?.code).toBe(gate.unidentified);
    expect(signing.spentCount()).toBe(0);
    const accepted = run(doc, { confirmation }, signing);
    expect(accepted.rejected).not.toBe(true);
    expect(signing.spentCount()).toBe(1);
    expect(run(doc, { confirmation }, signing).error?.code).toBe(gate.humanGate);
    expect(signing.spentCount()).toBe(1);
  });

  it('an agent without a signature is refused, and a recorded confirmation outside a replay is no signature', () => {
    for (const result of [
      run(doc, {}, port()),
      run(doc, { confirmation: true }, port()),
      run(doc, { confirmation: { verified: true } }, port()),
      run(doc, { confirmation }, null),
      execute(doc, command, gate.params, gate.baseContext),
    ]) {
      expect(result.error?.code).toBe(gate.humanGate);
      expect(result.document).toBe(doc);
    }
  });

  it('replay_history keeps the disposition without spending again, with any port or none; so does a reloaded document', () => {
    const signing = port();
    const once = run(doc, { confirmation }, signing).document;
    const replayed = replay(once, signing);
    expect(gate.stored(replayed)).toEqual(gate.stored(once));
    expect(ledger(replayed)).toEqual(ledger(once));
    expect(signing.spentCount()).toBe(1);
    expect(gate.stored(replay(once, port()))).toEqual(gate.stored(once));
    expect(gate.stored(replay(once, null))).toEqual(gate.stored(once));
    expect(gate.stored(replay(deserializeDocument(serializeDocument(signed)), null))).toEqual(gate.stored(signed));
  });

  it('a forged, altered, planted or missing ledger entry does not make a recorded step stick', () => {
    const entry = ledger(signed)[0];
    const replayWith = (patch: Record<string, unknown>): unknown =>
      gate.stored(
        replay(
          { ...signed, analysis: { ...signed.analysis, dispositionLedger: [{ ...entry, ...patch }] } } as unknown as CadDocument,
          port(),
        ),
      );
    expect(replayWith({})).toBeDefined();
    expect(replayWith({ signature: signedFor('0'.repeat(64)) })).toBeUndefined();
    expect(replayWith({ signature: { ...confirmation, secret: 'forged' } })).toBeUndefined();
    expect(replayWith({ signature: 'raw' })).toBeUndefined();
    expect(replayWith({ signer: 'mallory' })).toBeUndefined();
    expect(replayWith({ decision: 'rejected' })).toBeUndefined();
    expect(replayWith({ resultsHash: 'other' })).toBeUndefined();
    expect(replayWith({ rowKey: 'other-row' })).toBeUndefined();
    const { dispositionLedger, ...analysis } = signed.analysis ?? { cases: {}, caseOrder: [] };
    void dispositionLedger;
    expect(gate.stored(replay({ ...signed, analysis }, port()))).toBeUndefined();
  });

  it('a copy with another uid loses the disposition on replay, and the signature of this document does not verify in it', () => {
    const copy: CadDocument = { ...signed, uid: 'f'.repeat(32) };
    expect(gate.stored(replay(copy, port()))).toBeUndefined();
    const refused = run({ ...doc, uid: 'f'.repeat(32) }, { confirmation }, port());
    expect(refused.error?.code).toBe(gate.humanGate);
  });

  it('load validation rejects a malformed ledger', () => {
    const load = (edit: (analysis: Record<string, unknown>) => void): string => {
      const file = JSON.parse(serializeDocument(signed)) as { document: { analysis: Record<string, unknown> } };
      edit(file.document.analysis);
      return execute(createEmptyDocument(), 'load_document', { json: JSON.stringify(file) }).summary;
    };
    const entries = (analysis: Record<string, unknown>): Record<string, unknown>[] =>
      analysis['dispositionLedger'] as Record<string, unknown>[];
    expect(load(() => undefined)).toMatch(/^Loaded document/);
    expect(load((analysis) => (analysis['dispositionLedger'] = 'x'))).toMatch(/dispositionLedger must be a list/);
    expect(load((analysis) => (analysis['dispositionLedger'] = [3]))).toMatch(/dispositionLedger\[0\] is malformed/);
    expect(load((analysis) => (entries(analysis)[0]!['act'] = 'dispose_anything'))).toMatch(/act must be one of/);
    expect(load((analysis) => (entries(analysis)[0]!['decision'] = 'maybe'))).toMatch(/decision must be one of/);
    expect(load((analysis) => delete entries(analysis)[0]!['rowKey'])).toMatch(/rowKey must be text/);
    expect(load((analysis) => (entries(analysis)[0]!['documentUid'] = 3))).toMatch(/documentUid must be text/);
    expect(load((analysis) => (entries(analysis)[0]!['signature'] = 'raw'))).toMatch(/signature must be a signature object/);
  });
});
