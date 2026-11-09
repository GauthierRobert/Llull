/** NLS-M2b review round: thresholds (set_nonlinear_controls -> check_nonlinear / nonlinear_report), permanent set by step position, stale and untrusted results, curve rules. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { NonlinearSettings } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { snapBackDetected, unloadingStep } from '@cae/nonlinear/curveRules';
import { permanentSetOf } from '@cae/nonlinear/permanentSet';
import { estimatedRotation } from '@cae/nonlinear/smallDeformation';
import { nonlinearValueProblems } from '@cae/nonlinear/shape';
import { caseOf, withCase } from '@cae/shared/access';
import { solvedPressure, solvedPull, type SolvedCurve } from './limitFixtures';

interface Item {
  code: string;
  severity: string;
  ids: string[];
}
interface CheckData {
  status: string;
  items: Item[];
}
interface ReportData {
  permanentSet: Record<string, unknown> | null;
  thresholds: unknown;
}

type Control = NonlinearSettings['steps'][string]['control'];

const withDoc = (solved: SolvedCurve, doc: CadDocument): SolvedCurve => ({ ...solved, doc });
const check = (solved: SolvedCurve): CheckData =>
  execute(solved.doc, 'check_nonlinear', { analysisId: solved.analysisId }, solved.ctx).data as CheckData;
const report = (solved: SolvedCurve): ReturnType<typeof execute> =>
  execute(solved.doc, 'nonlinear_report', { analysisId: solved.analysisId }, solved.ctx);
const codes = (solved: SolvedCurve): string[] => check(solved).items.map((entry) => entry.code);
const nonlinearOf = (solved: SolvedCurve): NonlinearSettings => {
  const found = caseOf(solved.doc, solved.analysisId)?.nonlinear;
  if (found === undefined) throw new Error('no nonlinear settings');
  return found;
};

/** The pressure bar (nlgeom false, steps up / down, residual displacement 0.0005 and PEEQ 0.005 after `down`) with `thresholds` stated. */
function withThresholds(thresholds: Record<string, unknown>): SolvedCurve {
  const solved = solvedPressure();
  const result = execute(solved.doc, 'set_nonlinear_controls', { analysisId: solved.analysisId, nlgeom: false, thresholds });
  expect(result.rejected, result.summary).not.toBe(true);
  return withDoc(solved, result.document);
}

const limit = (value: number): { value: number; source: string } => ({ value, source: 'test: company rule' });

describe('set_nonlinear_controls thresholds', () => {
  it('stores them with their source, replaces them when given, keeps them when omitted, and keeps solved results current', () => {
    const solved = solvedPressure();
    const first = withThresholds({ permanentDisplacement: limit(0.01), strain: limit(0.02) });
    expect(nonlinearOf(first).thresholds).toEqual({ permanentDisplacement: limit(0.01), strain: limit(0.02) });
    expect(analysisInputHash(first.doc, first.analysisId, 'full')).toBe(analysisInputHash(solved.doc, solved.analysisId, 'full'));
    expect(report(first).error).toBeUndefined();
    const kept = execute(first.doc, 'set_nonlinear_controls', { analysisId: first.analysisId, nlgeom: false });
    expect(caseOf(kept.document, first.analysisId)?.nonlinear?.thresholds).toEqual({
      permanentDisplacement: limit(0.01),
      strain: limit(0.02),
    });
    const replaced = execute(first.doc, 'set_nonlinear_controls', {
      analysisId: first.analysisId,
      nlgeom: false,
      thresholds: { smallRotation: limit(0.1) },
    });
    expect(caseOf(replaced.document, first.analysisId)?.nonlinear?.thresholds).toEqual({ smallRotation: limit(0.1) });
    expect((report(first).data as ReportData).thresholds).toEqual({ permanentDisplacement: limit(0.01), strain: limit(0.02) });
  });

  it('refuses a non-positive value and an empty source; the document is unchanged', () => {
    const solved = solvedPressure();
    const base = { analysisId: solved.analysisId, nlgeom: false };
    const zero = execute(solved.doc, 'set_nonlinear_controls', { ...base, thresholds: { strain: limit(0) } });
    expect(zero.error?.code).toBe('NLS_CONTROL_INVALID');
    expect(zero.document).toBe(solved.doc);
    const negative = execute(solved.doc, 'set_nonlinear_controls', { ...base, thresholds: { strain: limit(-1) } });
    expect(negative.error?.code).toBe('NLS_CONTROL_INVALID');
    const empty = execute(solved.doc, 'set_nonlinear_controls', { ...base, thresholds: { strain: { value: 1, source: '' } } });
    expect(empty.rejected).toBe(true);
    expect(empty.document).toBe(solved.doc);
  });

  it('is validated on load: unknown keys, non-positive values and missing sources are reported', () => {
    const saved = JSON.parse(JSON.stringify(nonlinearOf(solvedPressure()))) as Record<string, unknown>;
    const problems = (thresholds: unknown): string[] => nonlinearValueProblems({ ...saved, thresholds }, 'nonlinear');
    expect(problems({ strain: limit(0.1) })).toEqual([]);
    expect(problems(undefined)).toEqual([]);
    expect(problems({ other: limit(1) })[0]).toContain('unknown key');
    expect(problems({ strain: { value: 0, source: 'x' } })[0]).toContain('strain');
    expect(problems({ strain: { value: 1, source: ' ' } })[0]).toContain('non-empty source');
    expect(problems('text')[0]).toContain('expected a record');
  });
});

describe('check_nonlinear against thresholds', () => {
  it('without any threshold it warns NLS_THRESHOLD_UNSET (nlgeom false) and NLS_PERMANENT_SET_THRESHOLD_UNSET (unloading step)', () => {
    expect(codes(solvedPressure())).toEqual(expect.arrayContaining(['NLS_THRESHOLD_UNSET', 'NLS_PERMANENT_SET_THRESHOLD_UNSET']));
  });

  it('a stated permanent-set limit suppresses its warning and judges the residual state: exceeded is an error', () => {
    const generous = withThresholds({ permanentDisplacement: limit(1), strain: limit(1) });
    expect(codes(generous)).not.toContain('NLS_PERMANENT_SET_THRESHOLD_UNSET');
    expect(codes(generous)).not.toContain('NLS_THRESHOLD_UNSET');
    expect(codes(generous)).not.toContain('NLS_PERMANENT_SET_EXCEEDED');
    expect((report(generous).data as ReportData).permanentSet).toMatchObject({ displacementExceeded: false, peeqExceeded: null });
    const tight = withThresholds({ permanentDisplacement: limit(0.0001), strain: limit(1) });
    expect(check(tight).items.find((entry) => entry.code === 'NLS_PERMANENT_SET_EXCEEDED')).toMatchObject({ severity: 'error' });
    expect(check(tight).status).toBe('fail');
    expect((report(tight).data as ReportData).permanentSet).toMatchObject({ displacementExceeded: true });
    const strain = withThresholds({ permanentPeeq: limit(0.001), strain: limit(1) });
    expect(codes(strain)).toContain('NLS_PERMANENT_SET_EXCEEDED');
    expect((report(strain).data as ReportData).permanentSet).toMatchObject({ peeqExceeded: true });
    expect(codes(withThresholds({ permanentPeeq: limit(0.5), strain: limit(1) }))).not.toContain('NLS_PERMANENT_SET_EXCEEDED');
  });

  it('nlgeom false: a strain or rotation beyond the stated limit recommends nlgeom, within it does not', () => {
    expect(codes(withThresholds({ permanentDisplacement: limit(1), strain: limit(0.001) }))).toContain('NLS_NLGEOM_RECOMMENDED');
    expect(codes(withThresholds({ permanentDisplacement: limit(1), smallRotation: limit(1e-6) }))).toContain('NLS_NLGEOM_RECOMMENDED');
    const fine = codes(withThresholds({ permanentDisplacement: limit(1), strain: limit(1), smallRotation: limit(0.5) }));
    expect(fine).not.toContain('NLS_NLGEOM_RECOMMENDED');
    expect(fine).not.toContain('NLS_THRESHOLD_UNSET');
  });

  it('judges the displacement limit in DOCUMENT units (mm document, mm analysis)', () => {
    expect(solvedPressure().doc.units).toBe('mm');
    expect(codes(withThresholds({ permanentDisplacement: limit(0.0006), strain: limit(1) }))).not.toContain('NLS_PERMANENT_SET_EXCEEDED');
    expect(codes(withThresholds({ permanentDisplacement: limit(0.0004), strain: limit(1) }))).toContain('NLS_PERMANENT_SET_EXCEEDED');
  });

  it('has no permanent-set warning for a monotonic displacement-controlled case', () => {
    expect(codes(solvedPull([105, 250, 260, 240, 200]))).not.toContain('NLS_PERMANENT_SET_THRESHOLD_UNSET');
  });
});

describe('permanentSet is matched to its step by position, not by name', () => {
  const rename = (solved: SolvedCurve, stepId: string, name: string): SolvedCurve =>
    withDoc(solved, execute(solved.doc, 'update_analysis_step', { analysisId: solved.analysisId, stepId, name }).document);

  it('survives renaming the unloading step after the solve (results stay current) and duplicate names', () => {
    const solved = solvedPressure();
    const [up, down] = nonlinearOf(solved).stepOrder;
    const renamed = rename(solved, down ?? '', 'relax');
    expect(analysisInputHash(renamed.doc, renamed.analysisId, 'full')).toBe(analysisInputHash(solved.doc, solved.analysisId, 'full'));
    expect((report(renamed).data as ReportData).permanentSet).toMatchObject({
      stepId: down,
      maxDisplacement: { value: 0.0005 },
      maxPeeq: { value: 0.005 },
    });
    const duplicated = rename(renamed, up ?? '', 'relax');
    expect((report(duplicated).data as ReportData).permanentSet).toMatchObject({ stepId: down, maxDisplacement: { value: 0.0005 } });
  });

  it('states a note when the unloading step stored no increment, and is null without an unloading step', () => {
    const solved = solvedPressure();
    const nonlinear = nonlinearOf(solved);
    const firstOnly = { ...solved.results, steps: solved.results.steps.filter((step) => step.step === 1) };
    const missing = permanentSetOf(nonlinear, solved.mesh, firstOnly);
    expect(missing).toMatchObject({ maxDisplacement: null, maxPeeq: null });
    expect(missing?.note).toContain('no stored increment');
    const noFields = { ...solved.results, steps: solved.results.steps.map((step) => ({ ...step, fields: {} })) };
    expect(permanentSetOf(nonlinear, solved.mesh, noFields)).toMatchObject({ maxDisplacement: null, maxPeeq: null });
    const pulled = solvedPull([1, 2, 3]);
    expect(permanentSetOf(nonlinearOf(pulled), pulled.mesh, pulled.results)).toBeNull();
  });

  it('estimatedRotation is null without displacements or nodes', () => {
    const solved = solvedPressure();
    expect(estimatedRotation(solved.mesh, { ...solved.results, steps: [] })).toBeNull();
    expect(estimatedRotation({ ...solved.mesh, nodes: [] }, solved.results)).toBeNull();
    expect(estimatedRotation(solved.mesh, solved.results)).toBeGreaterThan(0);
  });
});

describe('stale and untrusted stored results', () => {
  it('deleting a step or a probe makes the stored results stale: nonlinear_report refuses NLS_CURVE_STALE', () => {
    const solved = solvedPull([105, 250, 260]);
    const stepId = nonlinearOf(solved).stepOrder[0] ?? '';
    const noStep = withDoc(solved, execute(solved.doc, 'delete_analysis_step', { analysisId: solved.analysisId, stepId }).document);
    expect(analysisInputHash(noStep.doc, noStep.analysisId, 'full')).not.toBe(solved.results.inputHash);
    expect(report(noStep).error?.code).toBe('NLS_CURVE_STALE');
    const noProbe = withDoc(
      solved,
      execute(solved.doc, 'delete_curve_probe', { analysisId: solved.analysisId, probeId: solved.probeId }).document,
    );
    expect(report(noProbe).error?.code).toBe('NLS_CURVE_STALE');
    expect(report(solved).error).toBeUndefined();
  });

  it('a recorded summary that differs from its artifact is refused with FEA_SUMMARY_MISMATCH and read as untrusted by check_nonlinear', () => {
    const solved = solvedPull([105, 250, 260]);
    const analysis = caseOf(solved.doc, solved.analysisId);
    const results = analysis?.results;
    if (analysis === undefined || results?.nonlinear === undefined) throw new Error('fixture lost its results');
    const tampered = withDoc(
      solved,
      withCase(solved.doc, {
        ...analysis,
        results: {
          ...results,
          nonlinear: { ...results.nonlinear, curves: results.nonlinear.curves.map((curve) => ({ ...curve, peakLoad: 1 })) },
        },
      }),
    );
    const refused = report(tampered);
    expect(refused.error?.code).toBe('FEA_SUMMARY_MISMATCH');
    expect(refused.document).toBe(tampered.doc);
    expect((check(tampered) as unknown as { state: string }).state).toBe('untrusted');
  });
});

describe('curve rules', () => {
  const control = (value: number): Control => ({
    kind: 'displacement',
    target: { entityId: 'e' },
    dof: 'ux',
    value,
    initialIncrement: 0.1,
    minIncrement: 0.01,
    maxIncrement: 0.5,
    maxIncrements: 10,
  });
  const loadControl: Control = { kind: 'load', initialIncrement: 0.1, minIncrement: 0.01, maxIncrement: 0.5, maxIncrements: 10 };
  type StepSpec = [string, Record<string, number>, Control];
  const settings = (steps: StepSpec[]): NonlinearSettings => ({
    convergence: { name: 'ccx_default' },
    steps: Object.fromEntries(
      steps.map(([id, multipliers, stepControl]) => [id, { id, name: id, multipliers, amplitude: 'ramp', control: stepControl }]),
    ),
    stepOrder: steps.map(([id]) => id),
    constitutiveSets: {},
    probes: {},
    probeOrder: [],
    outputIncrements: 'all',
  });

  it('unloadingStep: needs a named load case, all zero, after a non-zero start; the last such step wins', () => {
    expect(unloadingStep(settings([['a', { LC1: 0 }, loadControl]]))).toBeUndefined();
    expect(
      unloadingStep(
        settings([
          ['a', { LC1: 5 }, loadControl],
          ['b', {}, loadControl],
        ]),
      ),
    ).toBeUndefined();
    expect(
      unloadingStep(
        settings([
          ['a', { LC1: 5 }, loadControl],
          ['b', { LC1: 0 }, loadControl],
        ]),
      ),
    ).toBe('b');
    expect(
      unloadingStep(
        settings([
          ['a', { LC1: 5 }, loadControl],
          ['b', { LC1: 0 }, loadControl],
          ['c', { LC1: 3 }, loadControl],
          ['d', { LC1: 0 }, loadControl],
        ]),
      ),
    ).toBe('d');
  });

  it('snapBackDetected: only inside a displacement step that advances, not after a load step or inside an unloading displacement step', () => {
    const curve = { probeId: 'p', name: 'p', time: [0, 0.5, 0.75, 1], load: [0, 10, 8, 6], displacement: [0, 2, 1.5, 1] };
    expect(snapBackDetected(settings([['a', {}, control(1)]]), curve)).toBe(true);
    expect(snapBackDetected(settings([['a', { LC1: 1 }, loadControl]]), curve)).toBe(false);
    const after = { ...curve, time: [1, 1.5, 1.75, 2] };
    expect(
      snapBackDetected(
        settings([
          ['a', { LC1: 1 }, loadControl],
          ['b', {}, control(1)],
        ]),
        after,
      ),
    ).toBe(true);
    expect(
      snapBackDetected(
        settings([
          ['a', {}, control(2)],
          ['b', {}, control(1)],
        ]),
        after,
      ),
    ).toBe(false);
    expect(snapBackDetected(settings([['a', {}, control(1)]]), { ...curve, load: [0, 10, 12, 14] })).toBe(false);
  });
});
