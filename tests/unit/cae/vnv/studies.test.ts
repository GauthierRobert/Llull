/**
 * Convergence studies (PHY-00 VNV-M3): record_convergence_study, check_verification, delete_convergence_study; VC-VNV-10 (record + report at the
 * level of fake artifacts), 13, 15, 16, 17. ORACLE (hand-derived, labelled): the synthetic solution f(h) = F0 + C h^2 with a constant spacing ratio 2
 * has observed order p = 2 and extrapolated value F0; with x = h1^2: f1 = F0 + C x, f2 = F0 + 4 C x, f3 = F0 + 16 C x, so
 * GCI21_fine = Fs * |f1 - f2| / f1 / (2^2 - 1) = 1.25 * 3 C x / (F0 + C x) / 3 and the asymptotic ratio is f2 / f1 (power law, constant ratio).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { expectCase } from '../../physics/benchmarkCases';
import { mustRun } from '../deckFixtures';
import { C, F0, recordedStudy, studyBar, type StudyBar } from './studyFixtures';

const FS = 1.25;
const PACK = '00-vv-harness';
type Data = {
  status: string;
  items: { code: string; severity: string; accepted?: unknown }[];
  studies: {
    id: string;
    state: string;
    codes: string[];
    unverified: boolean;
    reviewRequired: boolean;
    reviewReasons: string[];
    report?: Record<string, unknown> & { gci21?: { fine: number; coarse: number }; p?: number; extrapolated?: number };
  }[];
  reviewRequired: boolean;
  unverified: boolean;
};

const check = (
  bar: StudyBar,
  doc: CadDocument,
  extra: Record<string, unknown> = {},
): { result: ReturnType<typeof execute>; data: Data } => {
  const result = execute(doc, 'check_verification', { analysisId: bar.analysisId, ...extra }, bar.ctx);
  return { result, data: result.data as Data };
};

const codes = (data: Data): string[] => data.items.map((item) => item.code);

describe('record_convergence_study (VC-VNV-10 at the level of artifacts, VC-VNV-16)', () => {
  it('records a genuine study and check_verification re-derives order, extrapolation and GCI (hand-computed oracle)', () => {
    const bar = studyBar();
    const before = structuredClone(bar.doc);
    const result = execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: bar.study }, bar.ctx);
    expect(bar.doc).toEqual(before);
    expect(result.rejected).not.toBe(true);
    const studyId = result.affected[0] ?? '';
    expect(studyId).toMatch(/^cs-\d+\.\d+$/);
    expect(result.summary).toMatch(/3 levels.*monotone, observed order 2\.000.*extrapolated 100\.0.*MPa.*GCI, Fs 1\.25/);
    const analysisCase = result.document.analysis?.cases[bar.analysisId];
    expect(analysisCase?.studyOrder).toEqual([studyId]);
    const stored = analysisCase?.studies?.[studyId];
    expect(stored).toMatchObject({ id: studyId, analysisId: bar.analysisId, unit: 'MPa', refinement: 'h', ratio: 2 });
    expect(stored?.levels.map((level) => level.index)).toEqual([0, 1, 2]);
    expect(stored?.safetyFactor).toEqual({ value: FS, source: 'Roache 1994; Celik et al. 2008', defaulted: true });
    expect(stored?.formalOrder).toMatchObject({ value: 1, defaulted: true });
    expect(stored).not.toHaveProperty('report');

    const { data, result: checked } = check(bar, result.document, { gciTarget: 0.05 });
    expect(checked.document).toBe(result.document);
    const study = data.studies[0];
    expect(study?.state).toBe('current');
    const x = (stored?.levels[0]?.h ?? Number.NaN) ** 2;
    expect(study?.report?.p).toBeCloseTo(2, 9);
    expect(study?.report?.extrapolated).toBeCloseTo(F0, 8);
    expect(study?.report?.gci21?.fine).toBeCloseTo((FS * C * x) / (F0 + C * x), 9);
    expect(study?.report?.asymptoticRatio).toBeCloseTo((F0 + 4 * C * x) / (F0 + C * x), 8);
    expect(study?.report?.fractionUnit).toMatch(/fraction/);
    expect(data.status).toBe('warn');
    expect(codes(data)).toEqual(['VNV_ORDER_MISMATCH']);
    expect(checked.summary).toMatch(/observed order 2\.000.*estimated discretisation error/);
    expect(data.reviewRequired).toBe(true);
    expect(study?.reviewReasons).toEqual(['the quantity feeds a margin of safety']);
  });

  it('is deterministic: the same inputs give the same study (VC-VNV-17 at the level of artifacts)', () => {
    const first = recordedStudy(studyBar());
    const second = recordedStudy(studyBar());
    const same = JSON.stringify(first.doc.analysis) === JSON.stringify(second.doc.analysis);
    expectCase(PACK, 'VC-VNV-17', same ? 'identical study JSON' : 'different study JSON');
    expect(same).toBe(true);
  });

  it('refuses a hash absent from the store, an edited value and an edited spacing; accepts the genuine one (VC-VNV-16)', () => {
    const bar = studyBar();
    const levels = bar.study['levels'] as Record<string, unknown>[];
    const absent = execute(
      bar.doc,
      'record_convergence_study',
      {
        analysisId: bar.analysisId,
        study: { ...bar.study, levels: levels.map((level, index) => (index === 1 ? { ...level, resultsHash: 'a'.repeat(64) } : level)) },
      },
      bar.ctx,
    );
    expect(absent.rejected).toBe(true);
    expect(absent.error?.code).toBe('VNV_ARTIFACT_NOT_FOUND');
    expect(absent.error?.remediation).toMatch(/never hand-write/);
    expect(absent.document).toBe(bar.doc);

    const edited = execute(
      bar.doc,
      'record_convergence_study',
      {
        analysisId: bar.analysisId,
        study: { ...bar.study, levels: levels.map((level, index) => (index === 2 ? { ...level, value: 99 } : level)) },
      },
      bar.ctx,
    );
    expect(edited.error?.code).toBe('VNV_SUMMARY_MISMATCH');
    expect(edited.summary).toMatch(/level 2: the value re-extracted from the results is/);

    const spacing = execute(
      bar.doc,
      'record_convergence_study',
      {
        analysisId: bar.analysisId,
        study: {
          ...bar.study,
          levels: levels.map((level, index) => (index === 0 ? { ...level, h: (level['h'] as number) * 0.9 } : level)),
        },
      },
      bar.ctx,
    );
    expect(spacing.error?.code).toBe('VNV_SUMMARY_MISMATCH');

    const genuine = execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: bar.study }, bar.ctx);
    expect(genuine.rejected).not.toBe(true);
    expect(genuine.affected).toHaveLength(1);
    expectCase(PACK, 'VC-VNV-16', [
      absent.error?.code ?? 'none',
      edited.error?.code ?? 'none',
      genuine.rejected === true ? 'rejected' : 'accepted',
    ]);
  });

  it('refuses results bound to another mesh, other inputs, or a forged solver name', () => {
    const bar = studyBar();
    const levels = bar.study['levels'] as Record<string, unknown>[];
    const swapped = levels.map((level, index) => (index === 0 ? { ...level, meshHash: levels[1]?.['meshHash'] } : level));
    const run = (changedLevels: unknown): ReturnType<typeof execute> =>
      execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: { ...bar.study, levels: changedLevels } }, bar.ctx);
    expect(run(swapped).error?.code).toBe('VNV_SUMMARY_MISMATCH');
    expect(run(levels.map((level, index) => (index === 0 ? { ...level, inputHash: 'b'.repeat(64) } : level))).error?.code).toBe(
      'VNV_SUMMARY_MISMATCH',
    );
    expect(run(levels.map((level, index) => (index === 0 ? { ...level, solver: 'Forged' } : level))).error?.code).toBe(
      'VNV_SUMMARY_MISMATCH',
    );
    expect(run(levels.map((level, index) => (index === 0 ? { ...level, elements: 5 } : level))).error?.code).toBe('VNV_SUMMARY_MISMATCH');
  });

  it('refuses malformed input without changing the document', () => {
    const bar = studyBar();
    const levels = bar.study['levels'] as Record<string, unknown>[];
    const refuse = (params: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(bar.doc, 'record_convergence_study', params, bar.ctx);
    const unknown = refuse({ analysisId: 'an-9.9', study: bar.study });
    expect(unknown.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    expect(unknown.document).toBe(bar.doc);
    const reversed = refuse({ analysisId: bar.analysisId, study: { ...bar.study, levels: [...levels].reverse() } });
    expect(reversed.error?.code).toBe('VNV_LEVELS_INVALID');
    expect(reversed.error?.paths).toEqual(['study.levels.1.h']);
    expect(refuse({ analysisId: bar.analysisId, study: { ...bar.study, levels: levels.slice(0, 2) } }).error?.code).toBe(
      'CMD_INVALID_PARAMS',
    );
    expect(refuse({ analysisId: bar.analysisId, study: { ...bar.study, quantity: { kind: 'probe' } } }).error?.code).toBe(
      'VNV_PARAM_INVALID',
    );
    expect(refuse({ analysisId: bar.analysisId, study: { ...bar.study, quantity: { kind: 'frequency' } } }).error?.code).toBe(
      'VNV_PARAM_INVALID',
    );
    expect(
      refuse({ analysisId: bar.analysisId, study: { ...bar.study, quantity: { kind: 'field_max', field: 'u_mag' } } }).error?.code,
    ).toBe('VNV_PARAM_INVALID');
    const close = levels.map((level, index) => ({ ...level, h: (level['h'] as number) * (index === 0 ? 1 : 1 + 0.01 * index) }));
    expect(
      refuse({
        analysisId: bar.analysisId,
        study: { ...bar.study, levels: close.map((level, index) => ({ ...level, h: 1 + 0.01 * index })) },
      }).error?.code,
    ).toBe('VNV_RATIO_TOO_SMALL');
  });

  it('refuses a quantity the results cannot give', () => {
    const bar = studyBar();
    const refuse = (quantity: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: { ...bar.study, quantity } }, bar.ctx);
    expect(refuse({ kind: 'probe', probeId: 'p-none' }).error?.code).toBe('VNV_QUANTITY_UNAVAILABLE');
    expect(refuse({ kind: 'field_max', field: 'von_mises', loadCase: 'LC9' }).error?.code).toBe('VNV_QUANTITY_UNAVAILABLE');
    expect(refuse({ kind: 'frequency', mode: 1 }).error?.code).toBe('VNV_QUANTITY_UNAVAILABLE');
    expect(refuse({ kind: 'buckling_factor', mode: 1 }).error?.code).toBe('VNV_QUANTITY_UNAVAILABLE');
    expect(refuse({ kind: 'field_max', field: 'u_mag', loadCase: 'LC1' }).error?.code).toBe('VNV_SUMMARY_MISMATCH');
  });

  it('follows a probe: a probe study of the same fields records, with the load case named or implied', () => {
    const bar = studyBar();
    const record = (quantity: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: { ...bar.study, quantity } }, bar.ctx);
    expect(record({ kind: 'probe', probeId: bar.probeId }).rejected).not.toBe(true);
    expect(record({ kind: 'probe', probeId: bar.probeId, loadCase: 'LC1' }).rejected).not.toBe(true);
    expect(record({ kind: 'probe', probeId: bar.probeId, loadCase: 'LC2' }).error?.code).toBe('VNV_QUANTITY_UNAVAILABLE');
  });

  it('records WITHOUT a store as UNVERIFIED and check_verification then withholds every number', () => {
    const bar = studyBar();
    const result = execute(bar.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: bar.study });
    expect(result.rejected).not.toBe(true);
    expect(result.summary).toMatch(/UNVERIFIED/);
    const stored = Object.values(result.document.analysis?.cases[bar.analysisId]?.studies ?? {})[0];
    expect(stored?.verified).toBe(false);
    const { data } = check(bar, result.document);
    expect(data.studies[0]).toMatchObject({ state: 'unverifiable', codes: ['VNV_STUDY_UNVERIFIED'] });
    expect(data.studies[0]).not.toHaveProperty('report');
    expect(data.status).toBe('fail');
    const noPort = execute(recordedStudy(bar).doc, 'check_verification', { analysisId: bar.analysisId });
    expect((noPort.data as Data).studies[0]?.state).toBe('unverifiable');
  });
});

describe('check_verification (VC-VNV-13, 15)', () => {
  it('reports VNV_STUDY_STALE and no numbers once the analysis changes after the study (VC-VNV-13)', () => {
    const bar = studyBar();
    const { doc } = recordedStudy(bar);
    const loaded = mustRun(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'tip',
      kind: 'force',
      loadCase: 'LC1',
      category: 'limit',
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
      vector: [1, 0, 0],
    });
    const { data } = check(bar, loaded, { gciTarget: 0.05 });
    expect(codes(data)).toContain('VNV_STUDY_STALE');
    expectCase(PACK, 'VC-VNV-13', data.items.find((item) => item.code === 'VNV_STUDY_STALE')?.code ?? 'none');
    expect(data.studies[0]).toMatchObject({ state: 'stale', codes: ['VNV_STUDY_STALE'] });
    expect(data.studies[0]).not.toHaveProperty('report');
    expect(data.status).toBe('fail');
    const remedy = data.items.find((item) => item.code === 'VNV_STUDY_STALE') as unknown as { remediation: string };
    expect(remedy.remediation).toMatch(/re-run/);
  });

  it('goes stale when the geometry or the element order changes, not when only the global size does', () => {
    const bar = studyBar();
    const { doc } = recordedStudy(bar);
    const resized = mustRun(doc, 'set_mesh_controls', { analysisId: bar.analysisId, globalSize: 3 });
    expect(check(bar, resized).data.studies[0]?.state).toBe('current');
    const quadratic = mustRun(doc, 'set_mesh_controls', { analysisId: bar.analysisId, order: 2 });
    expect(check(bar, quadratic).data.studies[0]?.state).toBe('stale');
    const moved = mustRun(doc, 'scale_entity', { id: bar.boxId, factor: 2 });
    expect(check(bar, moved).data.studies[0]?.state).toBe('stale');
  });

  it('a study recorded for an older set-up is recorded stale, not refused (replay after a change)', () => {
    const bar = studyBar();
    const changedDoc = mustRun(bar.doc, 'scale_entity', { id: bar.boxId, factor: 2 });
    const result = execute(changedDoc, 'record_convergence_study', { analysisId: bar.analysisId, study: bar.study }, bar.ctx);
    expect(result.rejected).not.toBe(true);
    expect(result.summary).toMatch(/STALE/);
    expect(check(bar, result.document).data.studies[0]?.state).toBe('stale');
  });

  it('propagates unverified material data and review (VC-VNV-15)', () => {
    const bar = studyBar({ material: 'models' });
    const { doc } = recordedStudy(bar);
    const { data } = check(bar, doc);
    expect(codes(data)).toContain('VNV_INPUT_UNVERIFIED');
    expectCase(PACK, 'VC-VNV-15', data.items.find((item) => item.code === 'VNV_INPUT_UNVERIFIED')?.code ?? 'none');
    expect(data.unverified).toBe(true);
    expect(data.reviewRequired).toBe(true);
    expect(data.studies[0]).toMatchObject({ unverified: true, reviewRequired: true });
    expect(data.studies[0]?.reviewReasons).toContain('the material data is unverified');
    const trusted = check(studyBar(), recordedStudy(studyBar()).doc).data;
    expect(trusted.unverified).toBe(false);
    expect(codes(trusted)).not.toContain('VNV_INPUT_UNVERIFIED');
  });

  it('judges against the owner target; no default target (VNV_GCI_TARGET_UNSET)', () => {
    const bar = studyBar();
    const { doc } = recordedStudy(bar);
    const unset = check(bar, doc).data;
    expect(codes(unset)).toContain('VNV_GCI_TARGET_UNSET');
    expect(unset.status).toBe('warn');
    const tight = check(bar, doc, { gciTarget: 1e-6 }).data;
    expect(codes(tight)).toContain('VNV_GCI_ABOVE_TARGET');
    expect(codes(tight)).not.toContain('VNV_GCI_TARGET_UNSET');
    expect(tight.status).toBe('fail');
    expect(tight.studies[0]?.report?.['requiredSpacing']).toBeGreaterThan(0);
  });

  it('warns for a governing quantity without a study, and for an analysis without any', () => {
    const bar = studyBar();
    expect(codes(check(bar, bar.doc).data)).toContain('VNV_NO_CONVERGENCE_STUDY');
    const { doc } = recordedStudy(bar);
    const governing = check(bar, doc, { quantities: [{ kind: 'field_max', field: 'u_mag', loadCase: 'LC1' }] }).data;
    expect(codes(governing)).toContain('VNV_NO_CONVERGENCE_STUDY');
    const covered = check(bar, doc, { quantities: [{ kind: 'field_max', field: 'von_mises', loadCase: 'LC1' }] }).data;
    expect(codes(covered)).not.toContain('VNV_NO_CONVERGENCE_STUDY');
    const bad = execute(doc, 'check_verification', { analysisId: bar.analysisId, quantities: [{ kind: 'probe' }] }, bar.ctx);
    expect(bad.error?.code).toBe('VNV_PARAM_INVALID');
    expect(execute(doc, 'check_verification', { analysisId: 'an-9.9' }, bar.ctx).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });

  it('classifies an oscillating study without extrapolating', () => {
    const bar = studyBar({ value: (_h, level) => [100, 103, 101][level] ?? 0 });
    const { data } = check(bar, recordedStudy(bar).doc);
    expect(codes(data)).toContain('VNV_OSCILLATORY');
    expect(data.studies[0]?.report).toMatchObject({ status: 'oscillatory' });
    expect(data.studies[0]?.report).not.toHaveProperty('extrapolated');
  });

  it('flags a study whose recorded value no longer matches its artifact (hand-edited file)', () => {
    const bar = studyBar();
    const { doc, studyId } = recordedStudy(bar);
    const analysisCase = doc.analysis?.cases[bar.analysisId];
    const study = analysisCase?.studies?.[studyId];
    if (analysisCase === undefined || study === undefined) throw new Error('no study');
    const forged: CadDocument = {
      ...doc,
      analysis: {
        ...doc.analysis,
        cases: {
          ...doc.analysis?.cases,
          [bar.analysisId]: {
            ...analysisCase,
            studies: { [studyId]: { ...study, levels: study.levels.map((level) => ({ ...level, value: level.value + 1 })) } },
          },
        },
        caseOrder: doc.analysis?.caseOrder ?? [],
      },
    };
    const { data } = check(bar, forged);
    expect(data.studies[0]).toMatchObject({ state: 'untrusted', codes: ['VNV_SUMMARY_MISMATCH'] });
    expect(data.studies[0]).not.toHaveProperty('report');
  });
});

describe('delete_convergence_study', () => {
  it('removes the study and its order entry, leaving the case untouched', () => {
    const bar = studyBar();
    const { doc, studyId } = recordedStudy(bar);
    const before = structuredClone(doc);
    const result = execute(doc, 'delete_convergence_study', { analysisId: bar.analysisId, studyId });
    expect(doc).toEqual(before);
    expect(result.affected).toEqual([studyId]);
    const analysisCase = result.document.analysis?.cases[bar.analysisId];
    expect(analysisCase).not.toHaveProperty('studies');
    expect(analysisCase).not.toHaveProperty('studyOrder');
    expect(analysisCase?.mesh).toEqual(doc.analysis?.cases[bar.analysisId]?.mesh);
  });

  it('keeps the other studies, and refuses an unknown study or analysis', () => {
    const bar = studyBar();
    const first = recordedStudy(bar);
    const second = execute(first.doc, 'record_convergence_study', { analysisId: bar.analysisId, study: bar.study }, bar.ctx);
    const secondId = second.affected[0] ?? '';
    expect(secondId).not.toBe(first.studyId);
    const removed = execute(second.document, 'delete_convergence_study', { analysisId: bar.analysisId, studyId: first.studyId });
    expect(removed.document.analysis?.cases[bar.analysisId]?.studyOrder).toEqual([secondId]);
    const unknown = execute(first.doc, 'delete_convergence_study', { analysisId: bar.analysisId, studyId: 'cs-9.9' });
    expect(unknown.error?.code).toBe('VNV_STUDY_NOT_FOUND');
    expect(unknown.document).toBe(first.doc);
    expect(execute(first.doc, 'delete_convergence_study', { analysisId: 'an-9.9', studyId: first.studyId }).error?.code).toBe(
      'FEA_ANALYSIS_NOT_FOUND',
    );
  });
});
