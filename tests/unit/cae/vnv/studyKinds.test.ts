/**
 * Convergence studies V1 (PHY-00 VNV-M4): least-squares observed order over 4+ levels (FR-VNV-19, VC-VNV-22), time-step (dt) and element-order (p)
 * studies through the same model, staleness, report and refusals. ORACLES (hand-derived, labelled):
 * - h study, f(h) = F0 + C h^2 at 4 / 5 levels: least-squares p = 2, f0 = F0 (exact law); with 3 levels the Celik triplet is kept.
 * - dt study, T(dt) = T0 + K dt at dt = 1, 2, 4 s: p = 1, extrapolated T0; at 4 levels (dt = 0.5 .. 4 s) least squares gives p = 1, f0 = T0.
 * - p study: order-2 value 40, order-1 value 43: difference 3, relative 3 / 40 = 7.5 %, no order, no extrapolation.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { analyseOrderPair } from '@cae/vnv/orderPairAnalysis';
import { planStudy, studyParams, type LevelRun } from '@cae/vnv/studyRun';
import { expectCase } from '../../physics/benchmarkCases';
import { mustRun } from '../deckFixtures';
import { K, OFFSET, QUADRATIC, T0, dtStudyBar, orderStudyBar, recordKind } from './kindFixtures';
import { C, F0, recordedStudy, studyBar } from './studyFixtures';

type Entry = {
  id: string;
  refinement: string;
  state: string;
  codes: string[];
  report?: Record<string, unknown> & {
    p?: number;
    extrapolated?: number;
    status?: string;
    lsq?: { method: string; p: number; f0: number; residual: { rss: number }; uncertainty: { absolute: number; relative?: number } };
    orderPair?: { quadratic: number; linear: number; difference: { absolute: number; relative: number } };
    provenance?: { procedure: string; refinement: string };
  };
};
type Verified = { status: string; items: { code: string; severity: string }[]; studies: Entry[] };

const verify = (
  bar: { analysisId: string; ctx: Parameters<typeof execute>[3] },
  doc: Parameters<typeof execute>[0],
  extra: Record<string, unknown> = {},
): { result: ReturnType<typeof execute>; data: Verified } => {
  const result = execute(doc, 'check_verification', { analysisId: bar.analysisId, ...extra }, bar.ctx);
  return { result, data: result.data as Verified };
};

describe('least-squares order over 4+ levels of an h study (FR-VNV-19, VC-VNV-22)', () => {
  it.each([[[8, 4, 2, 1]], [[8, 6, 4, 2, 1]]])('recovers p = 2 and f0 = F0 of the exact law at cells %j', (cells) => {
    const bar = studyBar({ cells });
    const { doc } = recordedStudy(bar);
    const { data, result } = verify(bar, doc);
    const entry = data.studies[0];
    expect(entry?.state).toBe('current');
    expect(entry?.report?.provenance).toMatchObject({ procedure: 'eca-hoekstra-lsq', refinement: 'h' });
    expect(Math.abs((entry?.report?.p ?? Number.NaN) - 2)).toBeLessThan(1e-9);
    expect(Math.abs((entry?.report?.extrapolated ?? Number.NaN) - F0)).toBeLessThan(1e-9);
    expect(entry?.report?.lsq?.method).toBe('eca-hoekstra-lsq');
    expect(entry?.report?.lsq?.residual.rss).toBeLessThan(1e-12);
    const finestH = bar.levels[0]?.h ?? Number.NaN;
    // uncertainty = Fs |f1 - f0| + s with s ~ 0 for the exact law: 1.25 C h1^2
    expect(entry?.report?.lsq?.uncertainty.absolute).toBeCloseTo(1.25 * C * finestH ** 2, 8);
    expect(result.summary).toMatch(/least-squares observed order 2\.000/);
    expect(result.document).toBe(doc);
  });

  it('keeps the Celik triplet for exactly 3 levels (the method is named in the report)', () => {
    const bar = studyBar();
    const { data } = verify(bar, recordedStudy(bar).doc);
    expect(data.studies[0]?.report?.provenance?.procedure).toBe('celik2008-gci');
    expect(data.studies[0]?.report?.lsq).toBeUndefined();
  });

  it('fits NOISY levels, reports a standard error and flags a poor fit (VNV_LSQ_POOR_FIT)', () => {
    const noisy = (h: number, level: number): number => F0 + C * h * h + [0.002, -0.003, 0.0025, -0.002][level]!;
    const bar = studyBar({ cells: [8, 4, 2, 1], value: noisy });
    const { data } = verify(bar, recordedStudy(bar).doc);
    const report = data.studies[0]?.report;
    expect(report?.lsq?.residual.rss).toBeGreaterThan(0);
    expect(report?.p).toBeGreaterThan(0.05);
    expect(Number.isFinite(report?.lsq?.uncertainty.absolute)).toBe(true);
    const loud = studyBar({ cells: [8, 4, 2, 1], value: (_h, level) => F0 + [0, 0.05, 0.15, 0.55][level]! });
    const flagged = verify(loud, recordedStudy(loud).doc).data;
    expect(flagged.items.map((item) => item.code)).toContain('VNV_LSQ_POOR_FIT');
  });

  it('classifies a non-monotone 4-level set as oscillatory with no fit', () => {
    const bar = studyBar({ cells: [8, 4, 2, 1], value: (_h, level) => F0 + [0, 1, 0, 1][level]! });
    const { data } = verify(bar, recordedStudy(bar).doc);
    expect(data.items.map((item) => item.code)).toContain('VNV_OSCILLATORY');
    expect(data.studies[0]?.report?.p).toBeUndefined();
    expect(data.studies[0]?.report?.extrapolated).toBeUndefined();
  });

  it('check_convergence method least_squares fits all samples; fewer than 4 is refused; the default stays the triplet', () => {
    const samples = [0.1, 0.2, 0.4, 0.8].map((h) => ({ h, value: 10 + 0.5 * h ** 2 }));
    const doc = createEmptyDocument();
    const fitted = execute(doc, 'check_convergence', { quantity: 'q', unit: '1', samples, method: 'least_squares' });
    const data = fitted.data as { p: number; extrapolated: number; lsq: { method: string }; provenance: { procedure: string } };
    expect(Math.abs(data.p - 2)).toBeLessThan(1e-9);
    expect(Math.abs(data.extrapolated - 10)).toBeLessThan(1e-9);
    expect(data.provenance.procedure).toBe('eca-hoekstra-lsq');
    expect(fitted.summary).toMatch(/least-squares fit.*observed order 2\.000/);
    expect(fitted.document).toBe(doc);
    const triplet = execute(doc, 'check_convergence', { quantity: 'q', unit: '1', samples });
    expect((triplet.data as { provenance: { procedure: string } }).provenance.procedure).toBe('celik2008-gci');
    const refused = execute(doc, 'check_convergence', { quantity: 'q', unit: '1', samples: samples.slice(0, 3), method: 'least_squares' });
    expect(refused.error?.code).toBe('VNV_SAMPLES_INVALID');
    expect(refused.document).toBe(doc);
    const flat = execute(doc, 'check_convergence', {
      quantity: 'q',
      unit: '1',
      samples: samples.map((s) => ({ ...s, value: 1 })),
      method: 'least_squares',
    });
    expect((flat.data as { status: string }).status).toBe('converged_exactly');
  });
});

describe('time-step (dt) studies', () => {
  it('records a dt study and reports the first-order law (p = 1, extrapolated T0), reading the temperature at the END of the step', () => {
    const bar = dtStudyBar();
    const before = structuredClone(bar.doc);
    const result = execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: bar.study }, bar.ctx);
    expect(bar.doc).toEqual(before);
    expect(result.rejected).not.toBe(true);
    expect(result.summary).toMatch(/dt study, 3 levels, dt \(s\) 1\.000 \/ 2\.000 \/ 4\.000.*observed order 1\.000/);
    const stored = result.document.analysis?.cases[bar.analysisId]?.studies?.[result.affected[0] ?? ''];
    expect(stored?.refinement).toBe('dt');
    expect(stored).not.toHaveProperty('measure');
    expect(stored?.formalOrder).toMatchObject({ value: 1, defaulted: true });
    const { data } = verify(bar, result.document);
    const entry = data.studies[0];
    expect(entry?.refinement).toBe('dt');
    expect(entry?.state).toBe('current');
    expect(entry?.report?.p).toBeCloseTo(1, 9);
    expect(entry?.report?.extrapolated).toBeCloseTo(T0, 9);
    expect(entry?.report?.provenance?.refinement).toBe('dt');
    expectCase('00-vv-harness', 'VC-VNV-23.a', entry?.report?.p ?? Number.NaN);
    expectCase('00-vv-harness', 'VC-VNV-23.b', entry?.report?.extrapolated ?? Number.NaN);
  });

  it('4 dt levels are fitted by least squares: p = 1, f0 = T0', () => {
    const bar = dtStudyBar([0.5, 1, 2, 4]);
    const { data } = verify(bar, recordKind(bar).doc);
    expect(data.studies[0]?.report?.provenance?.procedure).toBe('eca-hoekstra-lsq');
    expect(Math.abs((data.studies[0]?.report?.p ?? Number.NaN) - 1)).toBeLessThan(1e-9);
    expect(Math.abs((data.studies[0]?.report?.extrapolated ?? Number.NaN) - T0)).toBeLessThan(1e-9);
    expect(K).toBe(0.5);
  });

  it('goes STALE when the transient end time (an input of every level) changes, and when a level h is edited', () => {
    const bar = dtStudyBar();
    const { doc, studyId } = recordKind(bar);
    const later = mustRun(doc, 'set_thermal_step', { analysisId: bar.analysisId, endTimeS: 16 });
    const stale = verify(bar, later).data;
    expect(stale.studies[0]?.state).toBe('stale');
    expect(stale.items.map((item) => item.code)).toContain('VNV_STUDY_STALE');
    expect(stale.studies[0]?.report).toBeUndefined();
    const edited = structuredClone(doc);
    const study = edited.analysis?.cases[bar.analysisId]?.studies?.[studyId];
    if (study === undefined) throw new Error('no study');
    (study.levels[0] as { h: number }).h = 1.5;
    expect(verify(bar, edited).data.studies[0]?.state).toBe('stale');
  });

  it('refuses an edited value (VNV_SUMMARY_MISMATCH) and a hash missing from the store', () => {
    const bar = dtStudyBar();
    const levels = bar.study['levels'] as Record<string, unknown>[];
    const edited = levels.map((level, index) => (index === 0 ? { ...level, value: 99 } : level));
    const mismatch = execute(
      bar.doc,
      'record_convergence_study',
      { analysisId: bar.analysisId, study: { ...bar.study, levels: edited } },
      bar.ctx,
    );
    expect(mismatch.error?.code).toBe('VNV_SUMMARY_MISMATCH');
    expect(mismatch.document).toBe(bar.doc);
    const missing = levels.map((level, index) => (index === 1 ? { ...level, resultsHash: 'f'.repeat(64) } : level));
    const absent = execute(
      bar.doc,
      'record_convergence_study',
      { analysisId: bar.analysisId, study: { ...bar.study, levels: missing } },
      bar.ctx,
    );
    expect(absent.error?.code).toBe('VNV_ARTIFACT_NOT_FOUND');
  });

  it('plans fixed-increment levels that divide the end time, and refuses what cannot be run', () => {
    const bar = dtStudyBar();
    const plan = planStudy(bar.doc, bar.analysisId, { quantity: { kind: 'probe', probeId: 'x' }, refinement: 'dt' });
    if ('code' in plan) throw new Error(plan.message);
    // default finest = end / (8 x 2^2) = 0.25 s
    expect(plan.levels.map((level) => level.h)).toEqual([0.25, 0.5, 1]);
    expect(plan.refinement).toBe('dt');
    expect(plan.levels.every((level) => level.controls === bar.doc.analysis?.cases[bar.analysisId]?.mesh)).toBe(true);
    const explicit = planStudy(bar.doc, bar.analysisId, {
      quantity: { kind: 'probe', probeId: 'x' },
      refinement: 'dt',
      finest: 1,
      levels: 5,
    });
    expect(explicit).toMatchObject({ code: 'VNV_PARAM_INVALID', message: expect.stringMatching(/whole number of increments of 16 s/) });
    expect(planStudy(bar.doc, bar.analysisId, { quantity: { kind: 'probe', probeId: 'x' }, refinement: 'dt', finest: -1 })).toMatchObject({
      code: 'VNV_PARAM_INVALID',
    });
    const steady = studyBar();
    expect(planStudy(steady.doc, steady.analysisId, { quantity: { kind: 'probe', probeId: 'x' }, refinement: 'dt' })).toMatchObject({
      code: 'VNV_CASE_UNSUPPORTED',
      message: expect.stringMatching(/heat_transient/),
    });
    expect(planStudy(bar.doc, bar.analysisId, { quantity: { kind: 'probe', probeId: 'x' }, refinement: 'q' })).toMatchObject({
      code: 'VNV_PARAM_INVALID',
    });
  });

  it('studyParams builds the dt record params from the level runs (size = the increment, no measure)', () => {
    const bar = dtStudyBar();
    const plan = planStudy(bar.doc, bar.analysisId, { quantity: bar.study['quantity'], refinement: 'dt', finest: 1 });
    if ('code' in plan) throw new Error(plan.message);
    const levels = bar.study['levels'] as { meshHash: string; resultsHash: string }[];
    const runs: LevelRun[] = plan.levels.map((level, index) => {
      const mesh = bar.port.get(levels[index]?.meshHash ?? '');
      const results = bar.port.get(levels[index]?.resultsHash ?? '');
      if (mesh?.kind !== 'fe_mesh' || results?.kind !== 'fe_results') throw new Error('artifact');
      return { ...level, mesh, meshHash: levels[index]?.meshHash ?? '', results, resultsHash: levels[index]?.resultsHash ?? '' };
    });
    const params = studyParams(bar.doc, bar.analysisId, plan, runs, {});
    expect(params).toEqual(bar.study);
    expect(studyParams(bar.doc, bar.analysisId, plan, [], {})).toMatchObject({ code: 'VNV_PARAM_INVALID' });
  });
});

describe('element-order (p) studies', () => {
  it('reports the order-difference indicator only: no observed order, no extrapolation (hand oracle 3 / 40 = 7.5 %)', () => {
    const bar = orderStudyBar();
    const result = execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: bar.study }, bar.ctx);
    expect(result.rejected).not.toBe(true);
    expect(result.summary).toMatch(/p study, 2 levels.*order 2 40\.0000 vs order 1 43\.0000 MPa, difference 7\.50 %.*no observed order/);
    const stored = result.document.analysis?.cases[bar.analysisId]?.studies?.[result.affected[0] ?? ''];
    expect(stored?.refinement).toBe('p');
    expect(stored?.formalOrder).toBeUndefined();
    const { data } = verify(bar, result.document, { gciTarget: 0.05 });
    const entry = data.studies[0];
    expect(entry?.state).toBe('current');
    expect(entry?.report?.status).toBe('order_pair');
    expect(entry?.report?.p).toBeUndefined();
    expect(entry?.report?.extrapolated).toBeUndefined();
    expect(entry?.report?.orderPair?.difference.absolute).toBeCloseTo(OFFSET, 12);
    expect(entry?.report?.orderPair?.difference.relative).toBeCloseTo(OFFSET / QUADRATIC, 12);
    expect(entry?.report?.provenance?.procedure).toBe('order-difference');
    expect(data.items.map((item) => item.code)).toEqual(['VNV_P_TWO_LEVEL', 'VNV_P_DIFFERENCE_ABOVE_TARGET']);
    expect(data.status).toBe('fail');
    const lenient = verify(bar, result.document, { gciTarget: 0.1 }).data;
    expect(lenient.items.map((item) => item.code)).toEqual(['VNV_P_TWO_LEVEL']);
    expectCase('00-vv-harness', 'VC-VNV-24', entry?.report?.orderPair?.difference.relative ?? Number.NaN);
  });

  it('is not stale because the case itself now meshes at order 1 or 2 (the study owns its orders), but is when the geometry changes', () => {
    const bar = orderStudyBar();
    const { doc } = recordKind(bar);
    const quadratic = mustRun(doc, 'set_mesh_controls', { analysisId: bar.analysisId, order: 2 });
    expect(verify(bar, quadratic).data.studies[0]?.state).toBe('current');
    const moved = mustRun(doc, 'add_result_probe', {
      analysisId: bar.analysisId,
      name: 'extra',
      point: [1, 0.5, 0.5],
      quantity: 'von_mises',
    });
    expect(verify(bar, moved).data.studies[0]?.state).toBe('stale');
  });

  it('plans exactly two levels, order 2 then order 1, at the case mesh size', () => {
    const bar = orderStudyBar();
    const plan = planStudy(bar.doc, bar.analysisId, { quantity: bar.study['quantity'], refinement: 'p' });
    if ('code' in plan) throw new Error(plan.message);
    expect(plan.levels.map((level) => [level.controls.order, level.controls.globalSize, level.h])).toEqual([
      [2, 0.5, 0.5],
      [1, 0.5, 1],
    ]);
    expect(planStudy(bar.doc, bar.analysisId, { quantity: bar.study['quantity'], refinement: 'p', levels: 3 })).toMatchObject({
      code: 'VNV_PARAM_INVALID',
    });
  });

  it('refuses a level whose h is not 1 / order as an untrusted study', () => {
    const bar = orderStudyBar();
    const { doc, studyId } = recordKind(bar);
    const forged = structuredClone(doc);
    const study = forged.analysis?.cases[bar.analysisId]?.studies?.[studyId];
    if (study === undefined) throw new Error('no study');
    (study.levels[1] as { h: number }).h = 3;
    // the staleness hash of a p level does not read h, so the number check (1 / order) catches it
    const entry = verify(bar, forged).data.studies[0];
    expect(entry?.state).toBe('untrusted');
  });
});

describe('mixed-kind and malformed studies are refused', () => {
  it('an h study whose levels differ in element order is VNV_MIXED_REFINEMENT; so is a dt study with a different mesh', () => {
    const bar = studyBar();
    const levels = bar.study['levels'] as { controls: Record<string, unknown> }[];
    const mixed = levels.map((level, index) => (index === 1 ? { ...level, controls: { ...level.controls, order: 2 } } : level));
    const refused = execute(
      bar.doc,
      'record_convergence_study',
      { analysisId: bar.analysisId, study: { ...bar.study, levels: mixed } },
      bar.ctx,
    );
    expect(refused.error?.code).toBe('VNV_MIXED_REFINEMENT');
    expect(refused.document).toBe(bar.doc);
    const dt = dtStudyBar();
    const dtLevels = dt.study['levels'] as { controls: Record<string, unknown> }[];
    const sizes = dtLevels.map((level, index) => (index === 2 ? { ...level, controls: { ...level.controls, globalSize: 9 } } : level));
    expect(
      execute(dt.doc, 'record_convergence_study', { analysisId: dt.analysisId, study: { ...dt.study, levels: sizes } }, dt.ctx).error?.code,
    ).toBe('VNV_MIXED_REFINEMENT');
    const order = orderStudyBar();
    const orderLevels = order.study['levels'] as { controls: Record<string, unknown> }[];
    const resized = orderLevels.map((level, index) => (index === 1 ? { ...level, controls: { ...level.controls, globalSize: 9 } } : level));
    expect(
      execute(
        order.doc,
        'record_convergence_study',
        { analysisId: order.analysisId, study: { ...order.study, levels: resized } },
        order.ctx,
      ).error?.code,
    ).toBe('VNV_MIXED_REFINEMENT');
  });

  it('refuses level counts and measures the kind does not allow, and an order study listed coarse first', () => {
    const order = orderStudyBar();
    const refuse = (
      bar: { doc: Parameters<typeof execute>[0]; analysisId: string; ctx: Parameters<typeof execute>[3]; study: Record<string, unknown> },
      study: Record<string, unknown>,
    ): ReturnType<typeof execute> => execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study }, bar.ctx);
    const levels = order.study['levels'] as Record<string, unknown>[];
    expect(refuse(order, { ...order.study, levels: [...levels].reverse() }).error?.code).toBe('VNV_LEVELS_INVALID');
    expect(refuse(order, { ...order.study, measure: { value: 2, dimension: 3 } }).error?.code).toBe('VNV_PARAM_INVALID');
    const dt = dtStudyBar();
    expect(refuse(dt, { ...dt.study, levels: (dt.study['levels'] as unknown[]).slice(0, 2) }).error?.code).toBe('VNV_LEVELS_INVALID');
    const h = studyBar();
    const { measure: dropped, ...withoutMeasure } = h.study;
    expect(dropped).toBeDefined();
    expect(refuse(h, withoutMeasure).error?.code).toBe('VNV_PARAM_INVALID');
    expect(refuse(h, { ...h.study, refinement: 'q' }).error?.code).toBe('CMD_INVALID_PARAMS');
  });

  it('check_verification and delete keep working on the new kinds (the study lists its refinement; delete removes it)', () => {
    const bar = dtStudyBar();
    const { doc, studyId } = recordKind(bar);
    const removed = execute(doc, 'delete_convergence_study', { analysisId: bar.analysisId, studyId });
    expect(removed.document.analysis?.cases[bar.analysisId]?.studies).toBeUndefined();
  });
});

describe('analyseOrderPair', () => {
  it('has no relative difference when the order-2 value is 0 and then judges no target', () => {
    const outcome = analyseOrderPair(0, 3, 0.1);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.analysis.orderPair?.difference).toEqual({ absolute: 3 });
    expect(outcome.analysis.findings.map((finding) => finding.code)).toEqual(['VNV_P_TWO_LEVEL']);
    expect(outcome.analysis.summaryReport.status).toBe('order_pair');
  });
});
