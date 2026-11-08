import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import { analysisInputHash } from '@cae/hash/inputHash';
import { marginDispositionPayload } from '@cae/margins/disposition';
import { limitLoadOf } from '@cae/nonlinear/limitLoad';
import { isRecord } from '@lib/isRecord';
import { solvedPressure, solvedPull, type SolvedCurve } from './limitFixtures';

describe('limitLoadOf (TR-NLS-05, synthetic curves)', () => {
  const d = [0, 1, 2, 3, 4, 5];

  it('peak: first maximum with the displacement increasing, refined by the parabola vertex', () => {
    // P = 10 d - d^2 sampled at integers: maximum 25 at d = 5 (last point: not a peak), so shift: P = 8 d - d^2 -> 16 at d = 4
    const P = d.map((x) => 8 * x - x * x);
    const found = limitLoadOf(P, d, 'peak');
    expect(found).toMatchObject({ found: 'peak', sample: { load: 16, displacement: 4, index: 4 }, limitLoad: 16, atDisplacement: 4 });
    // samples around a vertex that falls between them: P = 9 d - d^2 has its maximum 20.25 at d = 4.5
    const seven = [0, 1, 2, 3, 4, 5, 6];
    const off = limitLoadOf(
      seven.map((x) => 9 * x - x * x),
      seven,
      'auto',
    );
    expect(off.found).toBe('peak');
    if (off.found === 'peak') {
      expect(off.sample.load).toBe(20);
      expect(off.limitLoad).toBeCloseTo(20.25, 12);
      expect(off.atDisplacement).toBeCloseTo(4.5, 12);
    }
  });

  it('normalises signs (compressive load, negative displacement) and ignores an unloading drop', () => {
    const found = limitLoadOf(
      d.map((x) => -(8 * x - x * x)),
      d.map((x) => -x),
      'peak',
    );
    expect(found).toMatchObject({ found: 'peak', limitLoad: 16, atDisplacement: 4 });
    const unload = limitLoadOf([0, 10, 20, 10, 0], [0, 1, 2, 1.5, 1], 'auto');
    expect(unload).toEqual({ found: 'not_reached', lowerBound: 20, atDisplacement: 2 });
  });

  it('plateau: first displacement where the secant over the window drops below the fraction of the initial slope', () => {
    const P = [0, 100, 200, 240, 250, 251, 252];
    const x = [0, 1, 2, 3, 4, 5, 6];
    expect(limitLoadOf(P, x, 'plateau', { slopeFraction: 0.02, window: 1 })).toEqual({
      found: 'plateau',
      limitLoad: 250,
      atDisplacement: 4,
      index: 4,
    });
    expect(limitLoadOf(P, x, 'plateau', { slopeFraction: 0.02, window: 10 }).found).toBe('not_reached');
    expect(limitLoadOf(P, x, 'plateau').found).toBe('not_reached');
    expect(limitLoadOf([0, 0, 0], [0, 0, 0], 'plateau', { slopeFraction: 0.1, window: 1 }).found).toBe('not_reached');
  });

  it('not reached: a rising curve gives its largest load as a lower bound', () => {
    expect(limitLoadOf([0, 1, 2, 3], [0, 1, 2, 3], 'auto')).toEqual({ found: 'not_reached', lowerBound: 3, atDisplacement: 3 });
  });
});

type Data = Record<string, unknown> & { warnings: string[] };
const limit = (solved: SolvedCurve, params: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(solved.doc, 'limit_load', { analysisId: solved.analysisId, probe: solved.probeId, ...params }, solved.ctx);

describe('limit_load', () => {
  it('reads the peak of a displacement-controlled curve with provenance, curve hash and the review flag; is pure', () => {
    const solved = solvedPull([105, 250, 260, 240, 200]);
    const before = JSON.stringify(solved.doc);
    const result = limit(solved, { method: 'auto' });
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(solved.doc)).toBe(before);
    expect(result.document).toBe(solved.doc);
    const data = result.data as Data;
    expect(data).toMatchObject({
      found: 'peak',
      probeName: 'pull_curve',
      loadUnit: 'N',
      lengthUnit: 'mm',
      points: 6,
      reviewRequired: true,
    });
    expect(Number(data['limitLoad'])).toBeGreaterThan(260);
    expect(Number(data['limitLoad'])).toBeLessThan(265);
    expect(String(data['curveHash'])).toMatch(/^[0-9a-f]{64}$/);
    expect(data.warnings.join()).toContain('VNV_NO_CONVERGENCE_STUDY');
    expect(result.summary).toContain('(peak)');
    expect(result.summary).toContain('not approved');
    // by name as well as by id
    expect((limit(solved, { method: 'peak', probe: 'pull_curve' }).data as Data)['probeId']).toBe(solved.probeId);
  });

  it('gives only a lower bound when the curve never peaks (VC-NLS-60 analogue) and finds a plateau with explicit parameters', () => {
    const pressure = limit(solvedPressure(), { method: 'auto' });
    expect(pressure.data).toMatchObject({ found: 'not_reached', lowerBound: 50, loadUnit: 'MPa' });
    expect(pressure.summary).toContain('lower bound 50 MPa');
    expect((pressure.data as Data).warnings.join()).toContain('NLS_LIMIT_NOT_REACHED');
    const plateau = solvedPull([105, 210, 250, 251, 252]);
    expect(limit(plateau, { method: 'plateau', plateau: { slopeFraction: 0.02, window: 0.002 } }).data).toMatchObject({
      found: 'plateau',
      limitLoad: 250,
    });
  });

  it('refuses: plateau without parameters, unknown probe, stale curve, missing artifacts, linear case, unknown case', () => {
    const solved = solvedPull([105, 250, 260, 240, 200]);
    expect(limit(solved, { method: 'plateau' }).error?.code).toBe('NLS_PLATEAU_PARAMS_UNSET');
    expect(limit(solved, { method: 'plateau', plateau: { slopeFraction: 1.5, window: 1 } }).error?.code).toBe('NLS_PLATEAU_PARAMS_UNSET');
    expect(limit(solved, { method: 'peak', probe: 'ghost' }).error?.code).toBe('NLS_PROBE_REFERENCE_UNKNOWN');
    const changed = execute(solved.doc, 'set_nonlinear_controls', { analysisId: solved.analysisId, nlgeom: false });
    expect(limit({ ...solved, doc: changed.document }, { method: 'peak' }).error?.code).toBe('NLS_CURVE_STALE');
    expect(execute(solved.doc, 'limit_load', { analysisId: solved.analysisId, probe: solved.probeId, method: 'peak' }).error?.code).toBe(
      'FEA_RESULTS_MISSING',
    );
    const linear = execute(solved.doc, 'create_analysis', { name: 'lin', analysisType: 'static' });
    expect(limit({ ...solved, doc: linear.document, analysisId: linear.affected[0] ?? '' }, { method: 'peak' }).error?.code).toBe(
      'NLS_CASE_NOT_NONLINEAR',
    );
    const unknown = limit({ ...solved, analysisId: 'an-ghost' }, { method: 'peak' });
    expect(unknown.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    expect(unknown.document).toBe(solved.doc);
  });
});

describe('compute_margins criterion limit_load (FR-NLS-14, VC-NLS-67/68)', () => {
  const margins = (
    solved: SolvedCurve,
    limitLoad: Record<string, unknown> | undefined,
    extra: Record<string, unknown> = {},
  ): ReturnType<typeof execute> =>
    execute(
      solved.doc,
      'compute_margins',
      {
        analysisId: solved.analysisId,
        criterion: 'limit_load',
        ...(limitLoad === undefined ? {} : { limitLoad }),
        acceptInadequateMesh: true,
        ...extra,
      },
      solved.ctx,
    );
  const rowOf = (result: ReturnType<typeof execute>): Record<string, unknown> =>
    ((result.data as { rows: Record<string, unknown>[] }).rows[0] ?? {}) as Record<string, unknown>;

  it('passes with MS = P_limit / (P_design x 1.5) - 1 and fails below, FAIL pending a human; an agent disposition hits the human gate', () => {
    const solved = solvedPull([105, 250, 260, 240, 200]);
    const passing = margins(solved, {
      probe: solved.probeId,
      method: 'auto',
      designLoad: { value: 100, category: 'limit', source: 'test loads' },
    });
    expect(passing.error, passing.summary).toBeUndefined();
    const row = rowOf(passing);
    const capacity = Number(row['capacity']);
    expect(row['loadUnit']).toBe('N');
    expect(row).toMatchObject({
      criterion: 'limit_load',
      basis: 'peak',
      status: 'PASS',
      factorApplied: 1.5,
      reviewRequired: true,
      rowKey: `limit_load|${solved.probeId}|auto`,
    });
    expect(Number(row['ms'])).toBeCloseTo(capacity / 150 - 1, 12);
    expect((passing.data as Data).warnings.join()).toContain('VNV_NO_CONVERGENCE_STUDY');
    expect(passing.summary).toContain('not approved');
    const failing = margins(solved, {
      probe: solved.probeId,
      method: 'auto',
      designLoad: { value: 200, category: 'limit', source: 'test loads' },
    });
    expect(rowOf(failing)).toMatchObject({ status: 'FAIL', code: 'FEA_MS_NEGATIVE', disposition: 'pending_human' });
    const ultimate = margins(solved, {
      probe: solved.probeId,
      method: 'auto',
      designLoad: { value: 200, category: 'ultimate', source: 'test loads' },
    });
    expect(rowOf(ultimate)).toMatchObject({ status: 'PASS', factorApplied: 1 });
    const disposed = execute(
      { ...solved.doc, uid: solved.doc.uid ?? 'doc-test' },
      'dispose_margin',
      {
        analysisId: solved.analysisId,
        rowId: 'r1',
        decision: 'accepted',
        justification: 'agent attempt',
        confirmation: { signature: 'forged' },
        criterion: 'limit_load',
        limitLoad: { probe: solved.probeId, method: 'auto', designLoad: { value: 200, category: 'limit', source: 'test loads' } },
        acceptInadequateMesh: true,
      },
      solved.ctx,
    );
    expect(disposed.error?.code).toBe('FEA_HUMAN_GATE');
  });

  it('records a human disposition through a signing port (FAIL (accepted), status FAIL) that lapses when the design load changes', () => {
    const solved = solvedPull([105, 250, 260, 240, 200]);
    const doc = { ...solved.doc, uid: 'd'.repeat(32) };
    const SECRET = 'limit-load-test-secret';
    const port: HumanSignaturePort = {
      verify: (given, payload) =>
        isRecord(given) && given['secret'] === SECRET && given['payload'] === payload ? { signer: 'alice', signatureId: 'sig-1' } : null,
      spend: () => true,
    };
    const ctx = { ...solved.ctx, humanSignature: port };
    const limitLoad = { probe: solved.probeId, method: 'auto', designLoad: { value: 200, category: 'limit', source: 'test loads' } };
    const query = { analysisId: solved.analysisId, criterion: 'limit_load', limitLoad, acceptInadequateMesh: true };
    const row = rowOf(execute(doc, 'compute_margins', query, ctx)) as { rowKey: string; status: string; ms: number };
    expect(row.status).toBe('FAIL');
    const justification = 'accepted: test of the human gate';
    const payload = marginDispositionPayload(
      solved.analysisId,
      { rowKey: row.rowKey, status: row.status, ms: row.ms, inputHash: analysisInputHash(doc, solved.analysisId, 'full') },
      'accepted',
      justification,
      doc.analysis?.cases[solved.analysisId]?.results?.resultsHash ?? '',
      doc.uid,
    );
    const disposed = execute(
      doc,
      'dispose_margin',
      { ...query, rowId: 'r1', decision: 'accepted', justification, confirmation: { secret: SECRET, payload } },
      ctx,
    );
    expect(disposed.error, disposed.summary).toBeUndefined();
    const after = rowOf(execute(disposed.document, 'compute_margins', query, ctx));
    expect(after).toMatchObject({ status: 'FAIL', disposition: 'accepted', statusLabel: 'FAIL (accepted)' });
    const changed = { ...query, limitLoad: { ...limitLoad, designLoad: { ...limitLoad.designLoad, value: 210 } } };
    expect(rowOf(execute(disposed.document, 'compute_margins', changed, ctx))).toMatchObject({
      status: 'FAIL',
      disposition: 'pending_human',
    });
  });

  it('uses the probe load as the design load by default and the lower bound when the curve never peaks', () => {
    const pressure = solvedPressure();
    const result = margins(pressure, { probe: pressure.probeId, method: 'auto' });
    expect(result.error, result.summary).toBeUndefined();
    const row = rowOf(result);
    // the probe load is a pressure: the curve load axis, capacity and design load are MPa (N-mm-t-s), not N
    expect(row).toMatchObject({
      basis: 'lower_bound',
      capacity: 50,
      loadUnit: 'MPa',
      designLoad: { value: 1, stated: false, category: 'limit' },
    });
    expect(result.summary).toContain('capacity 50 MPa');
    expect(result.summary).not.toContain(' N ');
    expect(Number(row['ms'])).toBeCloseTo(50 / 1.5 - 1, 12);
    expect((result.data as Data).warnings.join()).toContain('NLS_LIMIT_NOT_REACHED');
  });

  it('refuses a missing limitLoad, stress-only params, a reaction probe without design load, a bad design load, limitLoad on stress criteria', () => {
    const solved = solvedPull([105, 250, 260, 240, 200]);
    const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
    expect(code(margins(solved, undefined))).toBe('FEA_MARGIN_PARAM_INVALID');
    expect(code(margins(solved, { probe: solved.probeId, method: 'auto' }))).toBe('FEA_MARGIN_PARAM_INVALID');
    expect(
      code(margins(solved, { probe: solved.probeId, method: 'auto', designLoad: { value: -1, category: 'limit', source: 'x' } })),
    ).toBe('FEA_MARGIN_PARAM_INVALID');
    expect(code(margins(solved, { probe: solved.probeId, method: 'auto', designLoad: { value: 1, category: 'limit', source: ' ' } }))).toBe(
      'FEA_MARGIN_PARAM_INVALID',
    );
    expect(code(margins(solved, { probe: solved.probeId, method: 'auto' }, { groupBy: 'part' }))).toBe('FEA_MARGIN_PARAM_INVALID');
    expect(code(margins(solved, { probe: 'ghost', method: 'auto' }))).toBe('NLS_PROBE_REFERENCE_UNKNOWN');
    const stress = execute(
      solved.doc,
      'compute_margins',
      { analysisId: solved.analysisId, limitLoad: { probe: solved.probeId, method: 'auto' } },
      solved.ctx,
    );
    expect(code(stress)).toBe('FEA_MARGIN_PARAM_INVALID');
    const plain = execute(solved.doc, 'compute_margins', { analysisId: solved.analysisId }, solved.ctx);
    expect(code(plain)).toBe('FEA_ANALYSIS_TYPE_UNSUPPORTED');
  });
});
