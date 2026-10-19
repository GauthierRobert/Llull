/**
 * Small-strain material-point driver (PHY-02 §5.3): N equal increments per step, strain targets imposed directly, stress targets found by a
 * global Newton on the stress residuals with a finite-difference tangent. Elasticity alone or with ONE of J2 / Hill-48 plasticity,Prony viscoelasticity
 * or creep.
 */

import type { MaterialModel, SetSlot } from '../materialModel';
import { solveLinear } from './linalg';
import { buildChannels, pathProblem } from './driverControl';
import { resolveSmallModel, type SmallModel } from './driverModel';
import {
  DEFAULT_DURATION_SECONDS,
  type DriverFailure,
  type DriverOutcome,
  type DriverRow,
  type PathStep,
  type Preset,
} from './driverTypes';
import { ValidityMonitor } from './driverValidity';
import { advance, backStressOf, initialState, type PointState, type TimeSlice } from './smallUpdate';
import { equivalentStrain, vonMises } from './tensor';
import { isLawFailure, newTrace, type ResolveEnv } from './resolve';
import type { PropertyRecord } from '../propertyModelEval';

export interface SmallRunInput {
  readonly record: PropertyRecord;
  readonly slots: Readonly<Partial<Record<SetSlot, MaterialModel>>>;
  readonly steps: readonly PathStep[];
  readonly preset: Preset | undefined;
  readonly output: 'increments' | 'steps';
  readonly maxIncrements?: number | undefined;
}

const GLOBAL_TOLERANCE = 1e-9;
const MAX_NEWTON = 50;

interface IncrementTarget {
  readonly known: ReadonlyArray<{ readonly index: number; readonly increment: number }>;
  readonly unknown: readonly number[];
  readonly stressTargets: readonly number[];
}

/** Advance one increment: strain components imposed, the others solved so that their stress meets the target. */
function solveIncrement(model: SmallModel, state: PointState, target: IncrementTarget, slice: TimeSlice): PointState | null {
  const dEps = [0, 0, 0, 0, 0, 0];
  for (const { index, increment } of target.known) dEps[index] = increment;
  if (target.unknown.length === 0) return advance(model, state, dEps, slice);
  const unknownStress = (next: PointState): number[] =>
    target.unknown.map((index, k) => (next.stress[index] ?? 0) - (target.stressTargets[k] ?? 0));
  let scale = model.referenceStress * 1e-3;
  for (const value of target.stressTargets) scale = Math.max(scale, Math.abs(value));
  for (const value of state.stress) scale = Math.max(scale, Math.abs(value));
  const tolerance = GLOBAL_TOLERANCE * scale;
  const first = advance(model, state, dEps, slice);
  if (first === null) return null;
  const firstResidual = unknownStress(first);
  if (firstResidual.every((value) => Math.abs(value) <= tolerance)) return first;
  const strainScale = Math.max(model.referenceStress / (model.elastic.iso?.E ?? model.referenceStress * 1e3), 1e-12);
  const residual = (x: readonly number[]): { readonly state: PointState; readonly r: number[] } | null => {
    const trial = [...dEps];
    target.unknown.forEach((index, k) => {
      trial[index] = x[k] ?? 0;
    });
    const next = advance(model, state, trial, slice);
    return next === null ? null : { state: next, r: unknownStress(next) };
  };
  let x = target.unknown.map(() => 0);
  let current: { readonly state: PointState; readonly r: number[] } | null = { state: first, r: firstResidual };
  for (let iteration = 0; iteration < MAX_NEWTON; iteration += 1) {
    if (current === null) return null;
    if (Math.max(...current.r.map(Math.abs)) <= tolerance) return current.state;
    const jacobian: number[][] = target.unknown.map(() => new Array<number>(target.unknown.length).fill(0));
    for (let j = 0; j < x.length; j += 1) {
      const h = 1e-5 * Math.max(Math.abs(x[j] ?? 0), strainScale);
      const bumped = x.map((value, k) => (k === j ? value + h : value));
      const probe = residual(bumped);
      if (probe === null) return null;
      for (let i = 0; i < x.length; i += 1) (jacobian[i] as number[])[j] = ((probe.r[i] ?? 0) - (current.r[i] ?? 0)) / h;
    }
    const step = solveLinear(
      jacobian,
      current.r.map((value) => -value),
    );
    if (step === null) return null;
    x = x.map((value, k) => value + (step[k] ?? 0));
    current = residual(x);
  }
  return current !== null && Math.max(...current.r.map(Math.abs)) <= tolerance * 10 ? current.state : null;
}

const rowOf = (state: PointState, step: number, increment: number, time: number, T: number | null, withCreep: boolean): DriverRow => ({
  step,
  increment,
  time,
  T,
  strain: state.strain,
  stress: state.stress,
  eqPlasticStrain: state.j2?.equivalentPlasticStrain ?? 0,
  vonMises: vonMises(state.stress),
  backStress: backStressOf(state),
  energyDensity: state.work,
  ...(withCreep ? { eqCreepStrain: state.creepEq } : {}),
});

const failureAt = (failure: DriverFailure, step: number, increment?: number): DriverFailure => ({
  ...failure,
  step,
  ...(increment !== undefined ? { increment } : {}),
});

/**
 * Run a small-strain path.
 * @failure invalid path -> MATL_PATH_INVALID; unresolved parameters -> their code; Newton failure -> MATL_PATH_DIVERGED (step, increment)
 */
export function runSmallStrain(input: SmallRunInput): DriverOutcome | DriverFailure {
  const invalidPath = pathProblem(input.steps, input.maxIncrements);
  if (invalidPath !== null) return invalidPath;
  const trace = newTrace();
  const rows: DriverRow[] = [];
  const usedDefaults = new Set<string>(['newtonTolerance']);
  const monitor = new ValidityMonitor(Object.values(input.slots));
  let state: PointState | null = null;
  let time = 0;
  for (const [stepIndex, step] of input.steps.entries()) {
    const T = step.temperatureK;
    const env: ResolveEnv = { record: input.record, at: T === null ? {} : { T: { value: T, unit: 'K' } }, trace };
    const model = resolveSmallModel(input.slots, env, T);
    if (isLawFailure(model)) return failureAt(model, stepIndex + 1);
    if (step.duration === null) usedDefaults.add('stepDuration');
    if (input.slots.rate?.model.kind === 'rate_johnson_cook') usedDefaults.add('johnsonCookBelowReferenceRate');
    let current: PointState = state ?? initialState(model);
    const stepStart = current;
    const channels = buildChannels(step, input.preset);
    const duration = step.duration ?? DEFAULT_DURATION_SECONDS;
    const start = channels.map((channel, c) => (channel.kind === 'strain' ? (stepStart.strain[c] ?? 0) : (stepStart.stress[c] ?? 0)));
    const unknown = channels.flatMap((channel, c) => (channel.kind === 'stress' ? [c] : []));
    for (let k = 1; k <= step.increments; k += 1) {
      const fraction = k / step.increments;
      const at = (c: number): number => (start[c] ?? 0) + ((channels[c]?.end ?? 0) - (start[c] ?? 0)) * fraction;
      const known = channels.flatMap((channel, c) =>
        channel.kind === 'strain' ? [{ index: c, increment: at(c) - (current.strain[c] ?? 0) }] : [],
      );
      const slice: TimeSlice = { t0: time + (duration * (k - 1)) / step.increments, t1: time + (duration * k) / step.increments };
      const before = current;
      const next = solveIncrement(model, before, { known, unknown, stressTargets: unknown.map(at) }, slice);
      if (next === null)
        return failureAt(
          {
            code: 'MATL_PATH_DIVERGED',
            path: `steps[${stepIndex}]`,
            message: 'the local or global Newton iteration did not converge',
            remediation: 'use more increments; check the law',
          },
          stepIndex + 1,
          k,
        );
      current = next;
      const dEps = current.strain.map((value, c) => value - (before.strain[c] ?? 0));
      monitor.check(
        {
          T,
          time: slice.t1,
          eqPlasticStrain: current.j2?.equivalentPlasticStrain ?? 0,
          strainRate: equivalentStrain(dEps) / Math.max(slice.t1 - slice.t0, Number.MIN_VALUE),
          stretch: null,
        },
        stepIndex + 1,
        k,
      );
      if (input.output === 'increments' || k === step.increments)
        rows.push(rowOf(current, stepIndex + 1, k, slice.t1, T, model.creep !== null));
    }
    state = current;
    time += duration;
  }
  return {
    rows,
    warnings: monitor.warnings,
    issues: [],
    unverifiedReasons: [...trace.unverifiedReasons, ...monitor.reasons],
    reviewRequired: trace.reviewRequired,
    usedDefaults,
  };
}
