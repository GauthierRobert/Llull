/** PHY-04 M4b review fixes: transient peak step for margins, orientation validation at load, ortho unverified reasons, stack-up spec temperature. */
import { describe, expect, it } from 'vitest';
import type { FeResultsArtifact } from '@core/model/analysis';
import { analysisErrors } from '@cae/model/validate';
import { stepOfLoadCase } from '@cae/results/fields';
import { preheatPeriodS } from '@cae/thermomech/preheat';
import { coupledFixture } from './coupledSupport';

type Step = FeResultsArtifact['steps'][number];

const stress = (s: number): Step['fields'][string] => ({
  components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'],
  values: { '1': [s, 0, 0, 0, 0, 0] },
});
const at = (step: number, time: number, s: number | null): Step => ({ step, time, fields: s === null ? {} : { STRESS: stress(s) } });
const resultsOf = (steps: Step[]): FeResultsArtifact => ({
  kind: 'fe_results',
  meshHash: 'm',
  inputHash: 'i',
  solver: 'ccx',
  solverVersion: '2.21',
  steps,
});

describe('stepOfLoadCase on a transient coupled case', () => {
  const transient = coupledFixture({ transient: { endTimeS: 100 } });
  const transientCase = transient.doc.analysis?.cases[transient.analysisId];
  const steady = coupledFixture();
  const steadyCase = steady.doc.analysis?.cases[steady.analysisId];

  it('picks the peak von Mises increment, not the last one (no pre-heating)', () => {
    const results = resultsOf([at(1, 10, 50), at(1, 50, 120), at(1, 100, 90)]);
    expect(stepOfLoadCase(results, 0, transientCase)?.time).toBe(50);
    expect(stepOfLoadCase(results, 0)?.time).toBe(100);
  });

  it('skips the pre-heating step (no output, or its uniform state) and reads the coupled step', () => {
    const results = resultsOf([at(1, 1, 400), at(2, 11, 30), at(2, 51, 120), at(2, 101, 90)]);
    expect(stepOfLoadCase(results, 0, transientCase)?.time).toBe(51);
    const noOutput = resultsOf([at(2, 11, 30), at(2, 51, 120), at(2, 101, 90)]);
    expect(stepOfLoadCase(noOutput, 0, transientCase)?.time).toBe(51);
    expect(stepOfLoadCase(noOutput, 0)).toBeUndefined();
  });

  it('first increment wins ties; no stress, no result sets, and steady / missing cases keep the step-index rule', () => {
    expect(stepOfLoadCase(resultsOf([at(1, 10, 5), at(1, 20, 5)]), 0, transientCase)?.time).toBe(10);
    expect(stepOfLoadCase(resultsOf([at(1, 10, null)]), 0, transientCase)).toBeUndefined();
    expect(stepOfLoadCase(resultsOf([]), 0, transientCase)).toBeUndefined();
    const results = resultsOf([at(1, 10, 50), at(1, 50, 120), at(1, 100, 90)]);
    expect(stepOfLoadCase(results, 0, steadyCase)?.time).toBe(100);
  });
});

describe('preheatPeriodS', () => {
  it('is the pre-heating period when the start differs from T_ref, else 0', () => {
    const hot = coupledFixture({ initial: 90, transient: { endTimeS: 100 } });
    const same = coupledFixture({ initial: 20, transient: { endTimeS: 100 } });
    const setupOf = (f: typeof hot): NonNullable<NonNullable<typeof hot.doc.analysis>['cases'][string]['thermomech']> & never =>
      f.doc.analysis?.cases[f.analysisId]?.thermomech as never;
    expect(preheatPeriodS(setupOf(hot))).toBe(1);
    expect(preheatPeriodS(setupOf(same))).toBe(0);
    const invalid = { ...(setupOf(hot) as object), referenceTemperature: { value: 1, unit: 'mm' } };
    expect(preheatPeriodS(invalid as never)).toBe(0);
  });
});

describe('thermomech.orientations validation at load', () => {
  const caseOf = (orientations: unknown): { errors: string[]; boxId: string } => {
    const { doc, analysisId, boxId } = coupledFixture();
    const raw = JSON.parse(JSON.stringify(doc)) as { analysis: { cases: Record<string, { thermomech: Record<string, unknown> }> } };
    const setup = raw.analysis.cases[analysisId]?.thermomech;
    if (setup !== undefined && orientations !== undefined) setup['orientations'] = orientations;
    return { errors: analysisErrors(raw as never), boxId };
  };

  it('accepts a valid record and an absent one', () => {
    const { boxId } = caseOf(undefined);
    expect(caseOf(undefined).errors).toEqual([]);
    expect(caseOf({ [boxId]: { axis1: [0, 3, 0], axis2: [1, 1, 0] } }).errors).toEqual([]);
  });

  it('refuses a non-record, an unknown part, malformed axes, a zero axis and parallel axes', () => {
    const { boxId } = caseOf(undefined);
    expect(caseOf([1]).errors.join('; ')).toContain('orientations must be a record keyed by part id');
    expect(caseOf('x').errors.join('; ')).toContain('orientations must be a record');
    expect(caseOf({ nope: { axis1: [1, 0, 0], axis2: [0, 1, 0] } }).errors.join('; ')).toContain("part 'nope' does not exist");
    expect(caseOf({ [boxId]: { axis1: [1, 0], axis2: [0, 1, 0] } }).errors.join('; ')).toContain('needs axis1 and axis2');
    expect(caseOf({ [boxId]: { axis1: [1, 0, 0], axis2: 'y' } }).errors.join('; ')).toContain('needs axis1 and axis2');
    expect(caseOf({ [boxId]: 3 }).errors.join('; ')).toContain('needs axis1 and axis2');
    expect(caseOf({ [boxId]: { axis1: [0, 0, 0], axis2: [0, 1, 0] } }).errors.join('; ')).toContain(
      'axis1 must be a finite non-zero vector',
    );
    expect(caseOf({ [boxId]: { axis1: [1, 0, 0], axis2: [2, 0, 0] } }).errors.join('; ')).toContain('not parallel to axis1');
  });
});
