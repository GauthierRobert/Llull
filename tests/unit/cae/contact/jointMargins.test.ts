/**
 * PHY-06 M4 compute_margins criterion joint (FR-CNT-12): separation and fastener-ultimate rows from the FE joint curve, dispositioned through dispose_margin.
 * Oracle: the synthetic joint of jointFixtures (N = 1000 + 0.2 L, the clamp zone opens between L = 200 and 300): P_sep >= 200 (last closed increment), and
 * N at the factored load 1.15 x 1.4 x 100 = 161 is 1000 + 0.2 x 161 = 1032.2 (linear on the curve).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { Disposition, HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { analysisInputHash } from '@cae/hash/inputHash';
import { marginDispositionPayload } from '@cae/margins/disposition';
import { caseOf, withCase } from '@cae/shared/access';
import { joint, type Jointed } from './jointFixtures';

const FACTORS = { separation: 1.2, ultimate: 1.4, fitting: 1.15, source: 'unit test programme rule (not a design rule)' };

const jointOf = (j: Jointed, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  pretension: j.boltId,
  loadProbe: 'pull',
  stepId: j.serviceId,
  designLoad: { value: 100, source: 'unit test load' },
  factors: FACTORS,
  ...extra,
});

/** compute_margins criterion joint: `extra` overrides joint fields; marginalBand goes to the table level. */
const margins = (j: Jointed, extra: Record<string, unknown> = {}, ctx = j.ctx): ReturnType<typeof execute> => {
  const { marginalBand, ...rest } = extra;
  return execute(
    j.doc,
    'compute_margins',
    { analysisId: j.b.analysisId, criterion: 'joint', joint: jointOf(j, rest), ...(marginalBand === undefined ? {} : { marginalBand }) },
    ctx,
  );
};

type Row = Record<string, unknown> & {
  rowId: string;
  rowKey: string;
  ms: number | null;
  status: string;
  criterion: string;
  disposition: string;
};
type Data = { rows: Row[]; warnings: string[]; omitted: string[]; minMs: number | null; overall: string };

describe('compute_margins criterion joint', () => {
  it('separation margin from the last closed increment and the ultimate margin from the bolt force at the factored load, both reviewRequired, pure', () => {
    const j = joint([5, 5, 5, 0, 0]);
    const before = structuredClone(j.doc);
    const result = margins(j, { fastenerAllowable: { value: 2000, source: 'unit test spec' }, marginalBand: 0.5 });
    expect(result.error).toBeUndefined();
    expect(j.doc).toEqual(before);
    expect(result.affected).toEqual([]);
    const data = result.data as Data;
    const [sep, ult] = data.rows;
    expect(sep).toMatchObject({ criterion: 'joint_separation', capacity: 200, separatedAt: 1.75, reviewRequired: true, rowId: 'r1' });
    expect(sep?.ms).toBeCloseTo(200 / (1.15 * 1.2 * 100) - 1, 12);
    expect(sep?.status).toBe('MARGINAL');
    expect(sep?.disposition).toBe('pending_human');
    expect(ult).toMatchObject({ criterion: 'fastener_ultimate', factoredLoad: expect.closeTo(161, 9), reviewRequired: true, rowId: 'r2' });
    expect(ult?.['boltForce']).toBeCloseTo(1032.2, 6);
    expect(ult?.ms).toBeCloseTo(2000 / 1032.2 - 1, 9);
    expect(ult?.status).toBe('PASS');
    expect(ult?.disposition).toBe('none');
    expect(data.minMs).toBeCloseTo(sep?.ms ?? 0, 12);
    expect(data.overall).toBe('marginal');
    expect(data.omitted[0]).toContain('joint_slip');
    expect(result.summary).toContain('joint_separation MS 0.44928');
    expect(result.summary).toContain('not approved');
  });

  it('a joint that never separates is bounded below by the largest load reached; no allowable gives no ultimate row; the missing band is named', () => {
    const j = joint([5, 5, 5, 5, 5]);
    const data = margins(j).data as Data;
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ capacity: 400, separatedAt: null });
    expect(String(data.rows[0]?.['basis'])).toContain('lower_bound');
    expect(data.rows[0]?.ms).toBeCloseTo(400 / (1.15 * 1.2 * 100) - 1, 12);
    expect(data.warnings.join(' ')).toContain('FEA_MARGINAL_BAND_UNSET');
  });

  it('a negative margin is a FAIL with the code, pending a human disposition', () => {
    const j = joint([5, 5, 5, 0, 0]);
    const data = margins(j, { designLoad: { value: 150, source: 'unit test load' } }).data as Data;
    expect(data.rows[0]).toMatchObject({ status: 'FAIL', code: 'CNT_MS_NEGATIVE', disposition: 'pending_human' });
    expect(data.rows[0]?.ms).toBeLessThan(0);
  });

  it('gives no ultimate row (and says so) when the factored load is beyond the load range of the step', () => {
    const j = joint([5, 5, 5, 5, 5]);
    const data = margins(j, { designLoad: { value: 300, source: 'unit test load' }, fastenerAllowable: { value: 2000, source: 's' } })
      .data as Data;
    expect(data.rows.map((row) => row.criterion)).toEqual(['joint_separation']);
    expect(data.warnings.join(' ')).toContain('outside the load range');
  });

  it.each([
    ['no factors', { factors: {} }, 'CNT_FACTORS_UNSET'],
    ['a factor of 0', { factors: { ...FACTORS, ultimate: 0 } }, 'CNT_FACTORS_UNSET'],
    ['no factor source', { factors: { ...FACTORS, source: ' ' } }, 'CNT_FACTORS_UNSET'],
    ['a design load of 0', { designLoad: { value: 0, source: 's' } }, 'CNT_FACTORS_UNSET'],
    ['a design load without source', { designLoad: { value: 1, source: ' ' } }, 'CNT_FACTORS_UNSET'],
    ['an allowable of 0', { fastenerAllowable: { value: 0, source: 's' } }, 'CNT_INPUT_INVALID'],
    ['an unknown bolt', { pretension: 'nope' }, 'CNT_PRETENSION_NOT_FOUND'],
    ['an unknown probe', { loadProbe: 'nope' }, 'CNT_INPUT_INVALID'],
  ])('refuses %s with %s', (_label, extra, code) => {
    const j = joint([5, 5, 5, 5, 5]);
    const result = margins(j, extra);
    expect(result.error?.code).toBe(code);
    expect(result.document).toEqual(j.doc);
  });

  it('refuses a step without enough increments with the probe load', () => {
    const j = joint([5, 5, 5, 5, 5], { tables: false });
    expect(margins(j).error?.code).toBe('CNT_INPUT_INVALID');
  });

  it('the capacity is the last closed load (200), not the largest load reached (400): the separation rule is what sets it', () => {
    const open = (margins(joint([5, 5, 5, 0, 0])).data as Data).rows[0];
    const closed = (margins(joint([5, 5, 5, 5, 5])).data as Data).rows[0];
    expect(open?.['capacity']).toBe(200);
    expect(closed?.['capacity']).toBe(400);
  });

  it('refuses CNT_SEPARATED when the clamp zone is already open at the first increment (not a silent capacity of the first load)', () => {
    const result = margins(joint([0, 5, 5, 5, 5]));
    expect(result.error?.code).toBe('CNT_SEPARATED');
    expect(result.summary).toContain('already open');
  });

  it('refuses a falling load over the step (CNT_INPUT_INVALID); joint_stiffness_from_fe warns instead', () => {
    const falling = joint([5, 5, 5, 5, 5], { load: (row) => (row.time === 1.5 ? 50 : row.load) });
    const result = margins(falling);
    expect(result.error?.code).toBe('CNT_INPUT_INVALID');
    expect(result.summary).toContain('falls between two increments');
    const stiffness = execute(
      falling.doc,
      'joint_stiffness_from_fe',
      { analysisId: falling.b.analysisId, pretension: falling.boltId, loadProbe: 'pull', stepId: falling.serviceId },
      falling.ctx,
    );
    expect((stiffness.data as { warnings: string[] }).warnings.join(' ')).toContain('falls between two increments');
  });

  it('rejects joint params on another criterion, stress params with the joint criterion and a missing joint param', () => {
    const j = joint([5, 5, 5, 0, 0]);
    const base = { analysisId: j.b.analysisId };
    expect(execute(j.doc, 'compute_margins', { ...base, joint: jointOf(j) }, j.ctx).error?.code).toBe('FEA_MARGIN_PARAM_INVALID');
    expect(execute(j.doc, 'compute_margins', { ...base, criterion: 'joint', joint: jointOf(j), groupBy: 'part' }, j.ctx).error?.code).toBe(
      'FEA_MARGIN_PARAM_INVALID',
    );
    expect(execute(j.doc, 'compute_margins', { ...base, criterion: 'joint' }, j.ctx).error?.code).toBe('FEA_MARGIN_PARAM_INVALID');
  });
});

describe('dispose_margin on a joint row (one signed human gate)', () => {
  const SIGNER = 'Dr. Reviewer';
  const JUSTIFICATION = 'joint tested to 1.4 x limit, report J-7';
  const failingJoint = { designLoad: { value: 150, source: 's' } };
  const port = (): HumanSignaturePort => ({
    verify: (signature, payload) =>
      isRecord(signature) && signature['payload'] === payload ? { signer: SIGNER, signatureId: `sig-${payload.slice(0, 8)}` } : null,
  });
  const failing = (): { j: Jointed; doc: CadDocument; human: ExecutionContext; row: Row } => {
    const j = joint([5, 5, 5, 0, 0]);
    const doc = { ...j.doc, uid: 'doc-joint-uid' } as CadDocument;
    const human: ExecutionContext = { ...j.ctx, humanSignature: port() };
    const table = execute(
      doc,
      'compute_margins',
      { analysisId: j.b.analysisId, criterion: 'joint', joint: jointOf(j, failingJoint) },
      human,
    );
    const row = (table.data as Data).rows[0];
    if (row === undefined) throw new Error('no row');
    return { j, doc, human, row };
  };
  const dispose = (j: Jointed, rowId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    analysisId: j.b.analysisId,
    criterion: 'joint',
    joint: jointOf(j, failingJoint),
    rowId,
    decision: 'accepted',
    justification: JUSTIFICATION,
    ...extra,
  });
  const recompute = (j: Jointed, doc: CadDocument, human: ExecutionContext): Row | undefined =>
    (
      execute(doc, 'compute_margins', { analysisId: j.b.analysisId, criterion: 'joint', joint: jointOf(j, failingJoint) }, human)
        .data as Data
    ).rows[0];

  it('a FAIL joint row is pending, an agent gets FEA_HUMAN_GATE, a signed disposition is recorded, shown "FAIL (accepted)" and re-verified; a tampered record is pending again', () => {
    const { j, doc, human, row } = failing();
    expect(row).toMatchObject({ status: 'FAIL', disposition: 'pending_human' });
    expect(execute(doc, 'dispose_margin', dispose(j, row.rowId, {}), j.ctx).error?.code).toBe('FEA_HUMAN_GATE');
    const payload = marginDispositionPayload(
      j.b.analysisId,
      { rowKey: row.rowKey, status: row.status, ms: row.ms, inputHash: analysisInputHash(doc, j.b.analysisId, 'full') },
      'accepted',
      JUSTIFICATION,
      caseOf(doc, j.b.analysisId)?.results?.resultsHash ?? '',
      'doc-joint-uid',
    );
    expect(execute(doc, 'dispose_margin', dispose(j, row.rowId, { confirmation: { payload: 'forged' } }), human).error?.code).toBe(
      'FEA_HUMAN_GATE',
    );
    const disposed = execute(doc, 'dispose_margin', dispose(j, row.rowId, { confirmation: { payload } }), human);
    expect(disposed.error, disposed.summary).toBeUndefined();
    const analysis = caseOf(disposed.document, j.b.analysisId);
    expect(analysis?.dispositions[row.rowKey]).toMatchObject({ decision: 'accepted', signer: SIGNER });
    expect(recompute(j, disposed.document, human)).toMatchObject({
      status: 'FAIL',
      statusLabel: 'FAIL (accepted)',
      disposition: 'accepted',
    });
    if (analysis === undefined) throw new Error('no analysis');
    const stored = analysis.dispositions[row.rowKey] as Disposition;
    const tampered = withCase(disposed.document, { ...analysis, dispositions: { [row.rowKey]: { ...stored, decision: 'rejected' } } });
    const tamperedRow = recompute(j, tampered, human);
    expect(tamperedRow).toMatchObject({ disposition: 'pending_human' });
    expect(String(tamperedRow?.['dispositionNote'])).toContain('does not verify');
  });

  it('a PASS joint row is not dispositioned (FEA_MARGIN_PARAM_INVALID)', () => {
    const j = joint([5, 5, 5, 0, 0]);
    const doc = { ...j.doc, uid: 'doc-joint-uid' } as CadDocument;
    const result = execute(
      doc,
      'dispose_margin',
      { ...dispose(j, 'r1', { confirmation: { payload: 'x' } }), joint: jointOf(j, { designLoad: { value: 10, source: 's' } }) },
      { ...j.ctx, humanSignature: port() },
    );
    expect(result.error?.code).toBe('FEA_MARGIN_PARAM_INVALID');
  });
});
