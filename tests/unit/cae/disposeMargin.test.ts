/** dispose_margin (05 §4, FR-FEA-33, AF-34; VC-FEA-62, VC-FEA-63): the human gate on FAIL / MARGINAL margin rows. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { Disposition, HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { analysisInputHash } from '@cae/hash/inputHash';
import { marginDispositionPayload } from '@cae/margins/disposition';
import { withCase } from '@cae/shared/access';
import { caseIn } from './helpers';
import { mustRun } from './deckFixtures';
import { marginBar, type MarginBar } from './marginsFixtures';

/** A signing port whose signature is the payload it signs (a stand-in for the 09 PLM key holder). */
const SIGNER = 'Dr. Reviewer';
const signingPort = (): HumanSignaturePort => ({
  verify: (signature, payload) =>
    isRecord(signature) && signature['payload'] === payload ? { signer: SIGNER, signatureId: `sig-${payload.slice(0, 8)}` } : null,
});

interface Row {
  rowId: string;
  rowKey: string;
  status: string;
  statusLabel: string;
  ms: number | null;
  disposition: string;
  dispositionRecord?: { decision: string; signer: string; justification: string };
  dispositionNote?: string;
}
const rowsOf = (result: ReturnType<typeof execute>): Row[] => (result.data as { rows: Row[] }).rows;

const bar = marginBar();
const humanContext = (): ExecutionContext => ({ ...bar.ctx, humanSignature: signingPort() });
const computed = (doc: CadDocument, ctx: ExecutionContext, params: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(doc, 'compute_margins', { analysisId: bar.analysisId, ...params }, ctx);

/** What a reviewer signs for `row` (the same payload the command verifies). */
function signatureFor(b: MarginBar, row: Row, decision: string, justification: string): { payload: string } {
  const resultsHash = caseIn(b.recorded, b.analysisId).results?.resultsHash ?? '';
  return {
    payload: marginDispositionPayload(
      b.analysisId,
      { rowKey: row.rowKey, status: row.status, ms: row.ms, inputHash: analysisInputHash(b.recorded, b.analysisId, 'full') },
      decision,
      justification,
      resultsHash,
    ),
  };
}

describe('dispose_margin: the human gate (VC-FEA-63)', () => {
  const failRow = rowsOf(computed(bar.recorded, bar.ctx))[0] as Row;
  const dispose = (ctx: ExecutionContext, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
    execute(
      bar.recorded,
      'dispose_margin',
      { analysisId: bar.analysisId, rowId: failRow.rowId, decision: 'accepted', justification: 'tested to 1.8 x limit', ...extra },
      ctx,
    );

  it('an agent without a signing port is refused with FEA_HUMAN_GATE, the document unchanged and the row still pending', () => {
    const result = dispose(bar.ctx);
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('FEA_HUMAN_GATE');
    expect(result.error?.remediation).toContain('qualified reviewer');
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(bar.recorded);
    expect(rowsOf(computed(result.document, bar.ctx))[0]).toMatchObject({ status: 'FAIL', disposition: 'pending_human' });
  });

  it('a port without a signature, or a signature that does not verify, is refused the same way', () => {
    expect(dispose(humanContext()).error?.code).toBe('FEA_HUMAN_GATE');
    expect(dispose(humanContext(), { signature: { payload: 'forged' } }).error?.code).toBe('FEA_HUMAN_GATE');
    const other = signatureFor(bar, failRow, 'rejected', 'tested to 1.8 x limit');
    expect(dispose(humanContext(), { signature: other }).error?.code).toBe('FEA_HUMAN_GATE');
  });

  it('is pure', () => {
    const snapshot = structuredClone(bar.recorded);
    dispose(humanContext(), { signature: signatureFor(bar, failRow, 'accepted', 'tested to 1.8 x limit') });
    expect(bar.recorded).toEqual(snapshot);
  });
});

describe('dispose_margin: a valid human signature', () => {
  const failRow = rowsOf(computed(bar.recorded, bar.ctx))[0] as Row;
  const justification = 'static test to 1.8 x limit load, report XYZ-12';
  const accepted = execute(
    bar.recorded,
    'dispose_margin',
    {
      analysisId: bar.analysisId,
      rowId: failRow.rowId,
      decision: 'accepted',
      justification,
      signature: signatureFor(bar, failRow, 'accepted', justification),
    },
    humanContext(),
  );

  it('records the disposition by stable row key with signer and results hash, and reports it', () => {
    expect(accepted.rejected).not.toBe(true);
    expect(accepted.affected).toEqual([bar.analysisId]);
    expect(accepted.summary).toContain(`FAIL accepted by ${SIGNER}`);
    expect(accepted.summary).toContain('the status stays FAIL');
    const stored = caseIn(accepted.document, bar.analysisId).dispositions[failRow.rowKey];
    expect(stored).toMatchObject({ decision: 'accepted', justification, signer: SIGNER });
    expect(stored?.resultsHash).toBe(caseIn(bar.recorded, bar.analysisId).results?.resultsHash);
    expect(failRow.rowKey).toBe(`LC1|${bar.boxId}|part|ultimate|von_mises`);
  });

  it('never turns the FAIL into a PASS: compute_margins shows "FAIL (accepted)" with the record and keeps the minimum margin', () => {
    const margins = computed(accepted.document, humanContext());
    const row = rowsOf(margins)[0] as Row;
    expect(row).toMatchObject({ status: 'FAIL', statusLabel: 'FAIL (accepted)', disposition: 'accepted' });
    expect(row.dispositionRecord).toMatchObject({ decision: 'accepted', signer: SIGNER, justification });
    expect(row.ms).toBeLessThan(0);
    expect((margins.data as { minMs: number }).minMs).toBe(row.ms);
    expect(margins.summary).toContain('0 pending a human disposition, 1 dispositioned by a human (status unchanged)');
    expect(margins.summary).toContain('FAIL (accepted)');
  });

  it('check_analysis keeps FEA_MS_NEGATIVE (fail) but no longer lists the row as pending', () => {
    const check = execute(accepted.document, 'check_analysis', { analysisId: bar.analysisId }, humanContext());
    const codes = (check.data as { items: { code: string }[] }).items.map((entry) => entry.code);
    expect((check.data as { status: string }).status).toBe('fail');
    expect(codes).toContain('FEA_MS_NEGATIVE');
    expect(codes).not.toContain('FEA_DISPOSITION_PENDING');
  });

  it('does not count without a signing port, after re-solving, or when the stored decision is tampered with', () => {
    const noPort = rowsOf(computed(accepted.document, bar.ctx))[0] as Row;
    expect(noPort).toMatchObject({ disposition: 'pending_human', statusLabel: 'FAIL (pending human disposition)' });
    expect(noPort.dispositionNote).toContain('no signing port');
    const stored = caseIn(accepted.document, bar.analysisId).dispositions[failRow.rowKey];
    const withDisposition = (patch: Partial<Disposition>): CadDocument => {
      const analysis = caseIn(accepted.document, bar.analysisId);
      return withCase(accepted.document, { ...analysis, dispositions: { [failRow.rowKey]: { ...(stored as Disposition), ...patch } } });
    };
    const resolved = rowsOf(computed(withDisposition({ resultsHash: 'other-results' }), humanContext()))[0] as Row;
    expect(resolved.dispositionNote).toContain('re-solved');
    expect(resolved.disposition).toBe('pending_human');
    const tampered = rowsOf(computed(withDisposition({ decision: 'rejected' }), humanContext()))[0] as Row;
    expect(tampered.dispositionNote).toContain('does not verify');
    const swapped = rowsOf(computed(withDisposition({ signer: 'someone else' }), humanContext()))[0] as Row;
    expect(swapped.dispositionNote).toContain('does not verify');
    const unsigned = rowsOf(computed(withDisposition({ signature: undefined }), humanContext()))[0] as Row;
    expect(unsigned.disposition).toBe('pending_human');
  });
});

describe('dispose_margin: refusals and row selection', () => {
  const human = humanContext();
  const base = { analysisId: bar.analysisId, decision: 'redesign', justification: 'thicken the web', signature: {} };
  const refusal = (params: Record<string, unknown>, doc = bar.recorded): string | undefined =>
    execute(doc, 'dispose_margin', { ...base, ...params }, human).error?.code;

  it('refuses an unknown analysis, an empty justification, an unknown row and a PASS row', () => {
    expect(refusal({ analysisId: 'an-9.9', rowId: 'r1' })).toBe('FEA_ANALYSIS_NOT_FOUND');
    expect(refusal({ rowId: 'r1', justification: '   ' })).toBe('FEA_PARAM_INVALID');
    expect(refusal({ rowId: 'r99' })).toBe('FEA_MARGIN_ROW_NOT_FOUND');
    expect(refusal({ rowId: 'r2' })).toBe('FEA_MARGIN_PARAM_INVALID');
  });

  it('refuses stale results and missing artifacts with the codes of compute_margins', () => {
    const stale = mustRun(bar.recorded, 'add_fea_load', { analysisId: bar.analysisId, name: 'g', kind: 'gravity', vector: [0, 0, -9810] });
    expect(refusal({ rowId: 'r1' }, stale)).toBe('FEA_RESULTS_STALE');
    const noStore = execute(
      bar.recorded,
      'dispose_margin',
      { ...base, rowId: 'r1' },
      { ...defaultContext(), humanSignature: signingPort() },
    );
    expect(noStore.error?.code).toBe('FEA_RESULTS_MISSING');
  });

  it('a marginalBand makes the yield row MARGINAL and dispositionable; rows are matched with the same query as compute_margins', () => {
    const query = { marginalBand: 1 };
    const rows = rowsOf(computed(bar.recorded, human, query));
    const marginal = rows.find((row) => row.status === 'MARGINAL') as Row;
    expect(marginal.rowKey).toBe(`LC1|${bar.boxId}|part|yield|von_mises`);
    const result = execute(
      bar.recorded,
      'dispose_margin',
      {
        analysisId: bar.analysisId,
        rowId: marginal.rowId,
        decision: 'accepted',
        justification: 'band agreed with the owner',
        signature: signatureFor(bar, marginal, 'accepted', 'band agreed with the owner'),
        ...query,
      },
      human,
    );
    expect(result.rejected).not.toBe(true);
    expect(result.summary).toContain('MARGINAL accepted');
    const after = rowsOf(computed(result.document, human, query));
    expect(after.find((row) => row.rowId === marginal.rowId)).toMatchObject({ status: 'MARGINAL', statusLabel: 'MARGINAL (accepted)' });
    expect(after.find((row) => row.status === 'FAIL')?.disposition).toBe('pending_human');
  });
});

describe('check_analysis margin items (VC-FEA-62)', () => {
  it('a negative margin without a band and without a disposition: fail with FEA_MS_NEGATIVE, FEA_MARGINAL_BAND_UNSET, FEA_DISPOSITION_PENDING', () => {
    const check = execute(bar.recorded, 'check_analysis', { analysisId: bar.analysisId }, bar.ctx);
    const data = check.data as { status: string; items: { code: string; severity: string; ids: string[]; remediation: string }[] };
    expect(data.status).toBe('fail');
    expect([...new Set(data.items.map((entry) => entry.code))].sort()).toEqual([
      'FEA_DISPOSITION_PENDING',
      'FEA_MARGINAL_BAND_UNSET',
      'FEA_MESH_ADEQUACY',
      'FEA_MS_NEGATIVE',
    ]);
    expect(data.items.find((entry) => entry.code === 'FEA_MS_NEGATIVE')).toMatchObject({ severity: 'error' });
    expect(data.items.every((entry) => entry.remediation.length > 0)).toBe(true);
  });

  it('positive margins only draw the unset-band warning; no strengths means no margin items', () => {
    const strong = marginBar({ ftu: 900, fty: 800 });
    const warned = execute(strong.recorded, 'check_analysis', { analysisId: strong.analysisId }, strong.ctx);
    expect((warned.data as { items: { code: string }[] }).items.map((entry) => entry.code)).toEqual([
      'FEA_MESH_ADEQUACY',
      'FEA_MARGINAL_BAND_UNSET',
    ]);
    const bare = marginBar({ ftu: null, fty: null });
    const silent = execute(bare.recorded, 'check_analysis', { analysisId: bare.analysisId }, bare.ctx);
    expect((silent.data as { items: { code: string }[] }).items.map((entry) => entry.code)).toEqual(['FEA_MESH_ADEQUACY']);
  });
});

describe('the signed payload names the model set-up', () => {
  it('a signature made over the same row but another analysis input hash (another document) does not verify', () => {
    const failRow = rowsOf(computed(bar.recorded, bar.ctx))[0] as Row;
    const justification = 'tested to 1.8 x limit';
    const resultsHash = caseIn(bar.recorded, bar.analysisId).results?.resultsHash ?? '';
    const foreign = marginDispositionPayload(
      bar.analysisId,
      { rowKey: failRow.rowKey, status: failRow.status, ms: failRow.ms, inputHash: 'another-document-input-hash' },
      'accepted',
      justification,
      resultsHash,
    );
    const result = execute(
      bar.recorded,
      'dispose_margin',
      { analysisId: bar.analysisId, rowId: failRow.rowId, decision: 'accepted', justification, signature: { payload: foreign } },
      humanContext(),
    );
    expect(result.summary).toContain('FEA_HUMAN_GATE');
    expect(result.document).toBe(bar.recorded);
  });
});
