/** nonlinear_report and check_nonlinear (PHY-05 NLS-M2b): solved curves as data, paging, snap-back, permanent set, guardrail items, refusals. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { run, SOURCE } from '../../physics/materials/materialFixtures';
import { barDocument } from '../deckFixtures';
import { solvedPressure, solvedPull, type SolvedCurve } from './limitFixtures';
import { nonlinearBar, pressureBar, pulledBar } from './support';

interface CurveData {
  name: string;
  points: number;
  load: number[];
  displacement: number[];
  curveHash: string;
  snapBack: boolean;
  sampled: boolean;
  from?: number;
  to?: number;
}
interface Data {
  state: string;
  status: string;
  nextCursor: number | null;
  curves: CurveData[];
  controls: { convergence: unknown; steps: unknown[] };
  steps: unknown[];
  maxPeeq: unknown;
  permanentSet: unknown;
  provenance: unknown;
  items: { code: string; severity: string; ids: string[]; remediation: string }[];
  notes: string[];
}

const report = (solved: SolvedCurve, params: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(solved.doc, 'nonlinear_report', { analysisId: solved.analysisId, ...params }, solved.ctx);

const check = (solved: SolvedCurve): ReturnType<typeof execute> =>
  execute(solved.doc, 'check_nonlinear', { analysisId: solved.analysisId }, solved.ctx);

const LOADS = [105, 250, 260, 240, 200];

describe('nonlinear_report', () => {
  it('returns controls with named values, steps, the curve with units, hashes and the review flag; is pure', () => {
    const solved = solvedPull(LOADS);
    const before = JSON.stringify(solved.doc);
    const result = report(solved);
    expect(result.error, result.summary).toBeUndefined();
    expect(JSON.stringify(solved.doc)).toBe(before);
    expect(result.document).toBe(solved.doc);
    expect(result.affected).toEqual([]);
    const data = result.data as Data;
    expect(data).toMatchObject({
      state: 'solved',
      nlgeom: true,
      unitSystem: 'N-mm-t-s',
      nextCursor: null,
      reviewRequired: true,
      unverified: false,
      permanentSet: null,
    });
    expect(data.controls.convergence).toMatchObject({ name: 'ccx_default', defaulted: true });
    expect(data.controls.steps[0]).toMatchObject({
      control: 'displacement',
      initialIncrement: { value: 0.1, source: 'plan', defaulted: false },
      maxIncrements: { value: 50, source: 'plan', defaulted: false },
    });
    expect(data.steps).toHaveLength(1);
    const curve = data.curves[0]!;
    expect(curve).toMatchObject({
      name: 'pull_curve',
      loadUnit: 'N',
      displacementUnit: 'mm',
      points: 6,
      maxLoad: 260,
      snapBack: false,
      sampled: false,
    });
    expect(curve.load).toEqual([0, -105, -250, -260, -240, -200]);
    expect(curve.displacement[0]).toBe(0);
    expect(curve.displacement.at(-1)).toBeCloseTo(0.01, 12);
    expect(curve.curveHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.provenance).toMatchObject({ solver: 'CalculiX', solverVersion: '2.21' });
    expect(result.summary).toContain('not approved');
    expect(result.summary).toContain('max load 260');
  });

  it('keeps at most 100 samples (first and last) in the summary view and pages increments "all" 1000 at a time', () => {
    const loads = Array.from({ length: 1100 }, (_, index) => index + 1);
    const solved = solvedPull(loads);
    const summary = (report(solved).data as Data).curves[0]!;
    expect(summary).toMatchObject({ points: 1101, sampled: true });
    expect(summary.load).toHaveLength(100);
    expect(summary.load[0]).toBe(0);
    expect(summary.load.at(-1)).toBe(-1100);
    const first = report(solved, { increments: 'all' });
    expect((first.data as Data).nextCursor).toBe(1000);
    expect((first.data as Data).curves[0]!).toMatchObject({ from: 0, to: 1000 });
    expect((first.data as Data).curves[0]!.load).toHaveLength(1000);
    expect(first.summary).toContain('cursor 1000');
    const second = report(solved, { increments: 'all', cursor: 1000 });
    expect((second.data as Data).nextCursor).toBeNull();
    expect((second.data as Data).curves[0]!).toMatchObject({ from: 1000, to: 1101 });
    expect((second.data as Data).curves[0]!.load.at(-1)).toBe(-1100);
  });

  it('selects one probe by id or name and refuses an unknown one', () => {
    const solved = solvedPull(LOADS);
    expect((report(solved, { probe: 'pull_curve' }).data as Data).curves.length).toBe(1);
    expect((report(solved, { probe: solved.probeId }).data as Data).curves.length).toBe(1);
    expect(report(solved, { probe: 'ghost' }).error?.code).toBe('NLS_PROBE_REFERENCE_UNKNOWN');
  });

  it('reads the residual state after an unloading step as permanentSet and the maximum equivalent plastic strain', () => {
    const solved = solvedPressure();
    const data = report(solved).data as Data;
    expect(data.maxPeeq).toMatchObject({ value: 0.005, step: 2 });
    expect(data.permanentSet).toMatchObject({
      stepId: solved.doc.analysis?.cases[solved.analysisId]?.nonlinear?.stepOrder[1],
      maxDisplacement: { value: 0.0005 },
      maxPeeq: { value: 0.005 },
    });
    expect(data.curves[0]!).toMatchObject({ loadUnit: 'MPa' });
  });

  it('flags a snap-back: the probe displacement falls with the load while the controlled displacement grows', () => {
    const turning = solvedPull(LOADS, [0.002, 0.004, 0.003, 0.0025, 0.002]);
    expect((report(turning).data as Data).curves[0]!.snapBack).toBe(true);
    expect((report(solvedPull(LOADS)).data as Data).curves[0]!.snapBack).toBe(false);
  });

  it('refuses: unknown and linear cases, stale and missing results, cursor without increments all', () => {
    const solved = solvedPull(LOADS);
    expect(report(solved, { analysisId: 'an-ghost' }).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    const linear = execute(solved.doc, 'create_analysis', { name: 'lin', analysisType: 'static' });
    expect(report({ ...solved, doc: linear.document, analysisId: linear.affected[0] ?? '' }).error?.code).toBe('NLS_CASE_NOT_NONLINEAR');
    expect(report(solved, { cursor: 5 }).error?.code).toBe('NLS_CONTROL_INVALID');
    const changed = execute(solved.doc, 'set_nonlinear_controls', { analysisId: solved.analysisId, nlgeom: false });
    const stale = report({ ...solved, doc: changed.document });
    expect(stale.error?.code).toBe('NLS_CURVE_STALE');
    expect(stale.document).toBe(changed.document);
    expect(execute(solved.doc, 'nonlinear_report', { analysisId: solved.analysisId }).error?.code).toBe('FEA_RESULTS_MISSING');
  });
});

/** Codes of the items of a check. */
const codes = (result: ReturnType<typeof execute>): string[] => (result.data as Data).items.map((entry) => entry.code);

describe('check_nonlinear', () => {
  it('lists the set-up warnings that need no solve and is pure', () => {
    const bar = pressureBar();
    const before = JSON.stringify(bar.doc);
    const result = execute(bar.doc, 'check_nonlinear', { analysisId: bar.analysisId });
    expect(JSON.stringify(bar.doc)).toBe(before);
    expect(result.document).toBe(bar.doc);
    const items = (result.data as Data).items;
    expect(items.find((entry) => entry.code === 'NLS_THRESHOLD_UNSET')).toMatchObject({ severity: 'warning', ids: [bar.analysisId] });
    expect(items.find((entry) => entry.code === 'NLS_PERMANENT_SET_THRESHOLD_UNSET')).toMatchObject({ ids: [bar.stepIds[1]] });
    expect(items.every((entry) => entry.remediation.length > 0)).toBe(true);
    expect(result.data).toMatchObject({ reviewRequired: true, state: 'unmeshed' });
    expect(result.summary).toContain('not approved');
  });

  it('is clean of the nlgeom / unload warnings for a monotonic nlgeom case', () => {
    const bar = pulledBar();
    const result = execute(bar.doc, 'check_nonlinear', { analysisId: bar.analysisId });
    expect(codes(result)).not.toContain('NLS_THRESHOLD_UNSET');
    expect(codes(result)).not.toContain('NLS_PERMANENT_SET_THRESHOLD_UNSET');
  });

  it('includes the check_analysis items and the nonlinear set-up errors, status fail', () => {
    const bar = pulledBar();
    const emptied = execute(bar.doc, 'delete_analysis_step', { analysisId: bar.analysisId, stepId: bar.stepId }).document;
    const result = execute(emptied, 'check_nonlinear', { analysisId: bar.analysisId });
    expect(codes(result)).toContain('NLS_NO_STEPS');
    expect((result.data as Data).status).toBe('fail');
    const unset = nonlinearBar();
    expect(codes(execute(unset.doc, 'check_nonlinear', { analysisId: unset.analysisId }))).toContain('NLS_NLGEOM_UNSET');
  });

  it('warns NLS_MATERIAL_MODEL_UNVERIFIED when E / nu come from a property model on an unverified basis', () => {
    const bar = pulledBar();
    const constant = (id: string, property: string, unit: string, value: number): Record<string, unknown> => ({
      id,
      property,
      unit,
      variables: [],
      validity: [],
      form: { kind: 'constant', value },
      basis: 'typical',
      source: SOURCE,
    });
    let doc: CadDocument = bar.doc;
    doc = run(doc, 'define_property_model', { material: 'steel', model: constant('E', 'E', 'GPa', 210) }).document;
    doc = run(doc, 'define_property_model', { material: 'steel', model: constant('nu', 'nu', '1', 0.3) }).document;
    doc = run(doc, 'add_material_model', {
      material: 'steel',
      id: 'linked',
      model: { kind: 'elastic_isotropic', E: { propertyModelId: 'E' }, nu: { propertyModelId: 'nu' } },
      basis: 'A',
      source: SOURCE,
    }).document;
    doc = run(doc, 'define_constitutive_set', {
      material: 'steel',
      set: { id: 'nlu', elastic: 'linked', plastic: 'j2' },
      makeDefault: true,
    }).document;
    const unverified = execute(doc, 'check_nonlinear', { analysisId: bar.analysisId });
    expect(codes(unverified)).toContain('NLS_MATERIAL_MODEL_UNVERIFIED');
    expect(codes(execute(bar.doc, 'check_nonlinear', { analysisId: bar.analysisId }))).not.toContain('NLS_MATERIAL_MODEL_UNVERIFIED');
  });

  it('on verified results reports the snap-back indicator and the guardrails not evaluated', () => {
    const turning = solvedPull(LOADS, [0.002, 0.004, 0.003, 0.0025, 0.002]);
    const result = check(turning);
    expect(codes(result)).toContain('NLS_SNAP_BACK_DETECTED');
    expect((result.data as Data).state).toBe('solved');
    expect((result.data as Data).notes.join()).toContain('not evaluated');
    const plain = check(solvedPull(LOADS));
    expect(codes(plain)).not.toContain('NLS_SNAP_BACK_DETECTED');
  });

  it('notes that result checks were skipped without verified results', () => {
    const bar = pulledBar();
    const result = execute(bar.doc, 'check_nonlinear', { analysisId: bar.analysisId });
    expect((result.data as Data).notes.join()).toContain('result checks skipped');
  });

  it('refuses unknown and linear cases', () => {
    const bar = pulledBar();
    const unknown = execute(bar.doc, 'check_nonlinear', { analysisId: 'an-ghost' });
    expect(unknown.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    expect(unknown.document).toBe(bar.doc);
    const linear = barDocument();
    expect(execute(linear.doc, 'check_nonlinear', { analysisId: linear.analysisId }).error?.code).toBe('NLS_CASE_NOT_NONLINEAR');
  });
});
