/** update_analysis_step, delete_analysis_step, delete_curve_probe (PHY-05 NLS-M2b): in-place edit, removal, refusals, purity, history replay. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { NonlinearSettings } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { caseOf } from '@cae/shared/access';
import { barDocument } from '../deckFixtures';
import { pressureBar, pulledBar } from './support';

const LOAD = { kind: 'load', initialIncrement: 0.2, minIncrement: 0.02, maxIncrement: 0.4, maxIncrements: 30 } as const;

const codeOf = (doc: CadDocument, command: string, params: Record<string, unknown>): string => {
  const result = execute(doc, command, params);
  expect(result.rejected, `${command}: ${result.summary}`).toBe(true);
  expect(result.document).toBe(doc);
  expect(result.affected).toEqual([]);
  return result.error?.code ?? '';
};

const nonlinearOf = (doc: CadDocument, analysisId: string): NonlinearSettings | undefined => caseOf(doc, analysisId)?.nonlinear;

describe('update_analysis_step', () => {
  it('edits name, multipliers, amplitude and control in place and keeps id, position and the other steps', () => {
    const bar = pressureBar();
    const [up, down] = bar.stepIds as [string, string];
    const result = execute(bar.doc, 'update_analysis_step', {
      analysisId: bar.analysisId,
      stepId: up,
      name: 'push harder',
      multipliers: { LC1: 80 },
      amplitude: 'step',
      control: LOAD,
    });
    expect(result.rejected).not.toBe(true);
    expect(result.affected).toEqual([up]);
    expect(result.summary).toContain(`'${up}'`);
    const after = nonlinearOf(result.document, bar.analysisId);
    expect(after?.stepOrder).toEqual([up, down]);
    expect(after?.steps[up]).toEqual({ id: up, name: 'push harder', multipliers: { LC1: 80 }, amplitude: 'step', control: LOAD });
    expect(after?.steps[down]).toEqual(nonlinearOf(bar.doc, bar.analysisId)?.steps[down]);
    expect(analysisInputHash(result.document, bar.analysisId, 'full')).not.toBe(analysisInputHash(bar.doc, bar.analysisId, 'full'));
  });

  it('changes only the given fields', () => {
    const bar = pressureBar();
    const [up] = bar.stepIds as [string, string];
    const before = nonlinearOf(bar.doc, bar.analysisId)?.steps[up];
    const result = execute(bar.doc, 'update_analysis_step', { analysisId: bar.analysisId, stepId: up, name: 'renamed' });
    expect(nonlinearOf(result.document, bar.analysisId)?.steps[up]).toEqual({ ...before, name: 'renamed' });
  });

  it('replaces a displacement control and validates the target', () => {
    const bar = pulledBar();
    const control = {
      kind: 'displacement',
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
      dof: 'ux',
      value: 0.02,
      initialIncrement: 0.1,
      minIncrement: 0.001,
      maxIncrement: 0.25,
      maxIncrements: 50,
    };
    const result = execute(bar.doc, 'update_analysis_step', { analysisId: bar.analysisId, stepId: bar.stepId, control });
    expect(nonlinearOf(result.document, bar.analysisId)?.steps[bar.stepId]?.control).toMatchObject({ kind: 'displacement', value: 0.02 });
    expect(
      codeOf(bar.doc, 'update_analysis_step', {
        analysisId: bar.analysisId,
        stepId: bar.stepId,
        control: { ...control, target: { entityId: bar.boxId } },
      }),
    ).toBe('FEA_TARGET_UNRESOLVED');
  });

  it('is pure', () => {
    const bar = pressureBar();
    const before = JSON.stringify(bar.doc);
    execute(bar.doc, 'update_analysis_step', { analysisId: bar.analysisId, stepId: bar.stepIds[0], name: 'x', multipliers: { LC1: 2 } });
    expect(JSON.stringify(bar.doc)).toBe(before);
  });

  it('refuses unknown analyses and steps, linear cases, an empty edit and invalid values with stable codes', () => {
    const bar = pressureBar();
    const stepId = bar.stepIds[0] ?? '';
    const base = { analysisId: bar.analysisId, stepId };
    expect(codeOf(bar.doc, 'update_analysis_step', { ...base, analysisId: 'an-0.0', name: 'x' })).toBe('FEA_ANALYSIS_NOT_FOUND');
    const linear = barDocument();
    expect(codeOf(linear.doc, 'update_analysis_step', { analysisId: linear.analysisId, stepId, name: 'x' })).toBe('NLS_CASE_NOT_NONLINEAR');
    expect(codeOf(bar.doc, 'update_analysis_step', { ...base, stepId: 'stp-9.9', name: 'x' })).toBe('NLS_STEP_NOT_FOUND');
    expect(codeOf(bar.doc, 'update_analysis_step', base)).toBe('NLS_CONTROL_INVALID');
    expect(codeOf(bar.doc, 'update_analysis_step', { ...base, control: { ...LOAD, minIncrement: 0.9 } })).toBe('NLS_CONTROL_INVALID');
    expect(codeOf(bar.doc, 'update_analysis_step', { ...base, multipliers: { NOPE: 1 } })).toBe('NLS_LOAD_CASE_UNKNOWN');
    expect(codeOf(bar.doc, 'update_analysis_step', { ...base, control: { kind: 'arc_length', initialArcLength: 0.1, maxSteps: 10 } })).toBe(
      'NLS_ARC_LENGTH_UNSUPPORTED',
    );
  });

  it('is re-minted identically by replay_history', () => {
    const bar = pressureBar();
    const edited = execute(bar.doc, 'update_analysis_step', {
      analysisId: bar.analysisId,
      stepId: bar.stepIds[0],
      multipliers: { LC1: 70 },
    });
    expect(edited.document.featureHistory.at(-1)).toMatchObject({ name: 'update_analysis_step' });
    expect(execute(edited.document, 'replay_history', {}).document.analysis).toEqual(edited.document.analysis);
  });
});

describe('delete_analysis_step', () => {
  it('removes the step and keeps the ids of the others', () => {
    const bar = pressureBar();
    const [up, down] = bar.stepIds as [string, string];
    const result = execute(bar.doc, 'delete_analysis_step', { analysisId: bar.analysisId, stepId: up });
    expect(result.affected).toEqual([up]);
    expect(result.summary).toContain('1 step(s) left');
    const after = nonlinearOf(result.document, bar.analysisId);
    expect(after?.stepOrder).toEqual([down]);
    expect(Object.keys(after?.steps ?? {})).toEqual([down]);
    expect(analysisInputHash(result.document, bar.analysisId, 'full')).not.toBe(analysisInputHash(bar.doc, bar.analysisId, 'full'));
  });

  it('is pure and replays to the same case', () => {
    const bar = pressureBar();
    const before = JSON.stringify(bar.doc);
    const result = execute(bar.doc, 'delete_analysis_step', { analysisId: bar.analysisId, stepId: bar.stepIds[1] });
    expect(JSON.stringify(bar.doc)).toBe(before);
    expect(execute(result.document, 'replay_history', {}).document.analysis).toEqual(result.document.analysis);
  });

  it('refuses unknown analyses, linear cases and unknown steps', () => {
    const bar = pressureBar();
    expect(codeOf(bar.doc, 'delete_analysis_step', { analysisId: 'an-0.0', stepId: bar.stepIds[0] })).toBe('FEA_ANALYSIS_NOT_FOUND');
    const linear = barDocument();
    expect(codeOf(linear.doc, 'delete_analysis_step', { analysisId: linear.analysisId, stepId: 'x' })).toBe('NLS_CASE_NOT_NONLINEAR');
    expect(codeOf(bar.doc, 'delete_analysis_step', { analysisId: bar.analysisId, stepId: 'stp-9.9' })).toBe('NLS_STEP_NOT_FOUND');
  });
});

describe('delete_curve_probe', () => {
  it('removes a probe by id or by name and keeps the rest', () => {
    const bar = pressureBar();
    const byId = execute(bar.doc, 'delete_curve_probe', { analysisId: bar.analysisId, probeId: bar.probeId });
    expect(byId.affected).toEqual([bar.probeId]);
    expect(nonlinearOf(byId.document, bar.analysisId)?.probeOrder).toEqual([]);
    expect(nonlinearOf(byId.document, bar.analysisId)?.probes).toEqual({});
    expect(nonlinearOf(byId.document, bar.analysisId)?.stepOrder).toEqual(bar.stepIds);
    const byName = execute(bar.doc, 'delete_curve_probe', { analysisId: bar.analysisId, probeId: 'bore' });
    expect(byName.affected).toEqual([bar.probeId]);
    expect(analysisInputHash(byId.document, bar.analysisId, 'full')).not.toBe(analysisInputHash(bar.doc, bar.analysisId, 'full'));
  });

  it('is pure and replays to the same case', () => {
    const bar = pressureBar();
    const before = JSON.stringify(bar.doc);
    const result = execute(bar.doc, 'delete_curve_probe', { analysisId: bar.analysisId, probeId: bar.probeId });
    expect(JSON.stringify(bar.doc)).toBe(before);
    expect(execute(result.document, 'replay_history', {}).document.analysis).toEqual(result.document.analysis);
  });

  it('refuses unknown analyses, linear cases and unknown probes', () => {
    const bar = pressureBar();
    expect(codeOf(bar.doc, 'delete_curve_probe', { analysisId: 'an-0.0', probeId: bar.probeId })).toBe('FEA_ANALYSIS_NOT_FOUND');
    const linear = barDocument();
    expect(codeOf(linear.doc, 'delete_curve_probe', { analysisId: linear.analysisId, probeId: 'x' })).toBe('NLS_CASE_NOT_NONLINEAR');
    expect(codeOf(bar.doc, 'delete_curve_probe', { analysisId: bar.analysisId, probeId: 'prb-9.9' })).toBe('NLS_PROBE_REFERENCE_UNKNOWN');
  });
});
