/**
 * Finite-strain driver for COMPRESSIBLE hyperelastic laws (PHY-02 §5.6, V2): general homogeneous paths on the upper-triangular deformation
 * gradient F = [[F11, γxy, γxz], [0, F22, γyz], [0, 0, F33]]. Each component is controlled by a strain (normal: nominal strain F_ii − 1; shear:
 * F_ij = γ, simple-shear convention) or a stress (normal: nominal / first Piola-Kirchhoff P_ii; shear: Cauchy σ_ij). Uncontrolled components are
 * stress-free: their F entries are solved by a damped Newton iteration on the stress residuals (finite-difference tangent), so uniaxial stress
 * contracts laterally by itself. Presets fill the components a step leaves out.
 */

import type { MaterialModel } from '../materialModel';
import { buildChannels, pathProblem, type Channel } from './driverControl';
import {
  COMPONENTS,
  DEFAULT_DURATION_SECONDS,
  MAX_TOTAL_INCREMENTS,
  type Component,
  type DriverFailure,
  type DriverOutcome,
  type DriverRow,
  type PathStep,
  type Preset,
} from './driverTypes';
import { ValidityMonitor } from './driverValidity';
import { finiteResponse, identity3, type CompressibleLaw, type FiniteResponse, type Mat3 } from './finiteStress';
import { resolveHyper, type HyperLaw } from './hyperResolve';
import { resolveVolumetric } from './hyperVolumetric';
import { solveLinear } from './linalg';
import { failure, isLawFailure } from './resolve';
import { vonMises, zero6 } from './tensor';

export interface CompressibleRunInput {
  readonly model: MaterialModel;
  readonly steps: readonly PathStep[];
  readonly preset: Preset | undefined;
  readonly output: 'increments' | 'steps';
  readonly maxIncrements?: number | undefined;
}

/** F entry (row, column) driven by each component. */
const ENTRY: Readonly<Record<Component, readonly [number, number]>> = {
  xx: [0, 0],
  yy: [1, 1],
  zz: [2, 2],
  xy: [0, 1],
  xz: [0, 2],
  yz: [1, 2],
};

const MAX_NEWTON = 50;
const RELATIVE_TOLERANCE = 1e-10;

const entryOf = (F: Mat3, component: Component): number => {
  const [i, j] = ENTRY[component];
  return F[i]?.[j] ?? 0;
};

const withEntry = (F: Mat3, component: Component, value: number): Mat3 => {
  const [i, j] = ENTRY[component];
  return F.map((row, r) => row.map((x, c) => (r === i && c === j ? value : x)));
};

/** The controlled quantity of one channel in a response: P_ii for a normal component, σ_ij (Cauchy) for a shear one. */
function stressOf(response: FiniteResponse, component: Component): number {
  const [i, j] = ENTRY[component];
  return i === j ? (response.nominal[i]?.[i] ?? 0) : (response.stress[COMPONENTS.indexOf(component)] ?? 0);
}

const fail = (code: string, message: string, step: number, increment?: number): DriverFailure => ({
  code,
  path: `steps[${step - 1}]`,
  message,
  remediation: 'use more increments, a smaller target, or check the law parameters',
  step,
  ...(increment !== undefined ? { increment } : {}),
});

interface Target {
  readonly component: Component;
  readonly kind: 'strain' | 'stress';
  readonly value: number;
}

/** Damped Newton on the stress-free / stress-controlled components; the strain-controlled entries are imposed. */
function solveIncrement(
  law: CompressibleLaw,
  guess: Mat3,
  targets: readonly Target[],
  scale: number,
): { F: Mat3; response: FiniteResponse } | null {
  const strain = targets.filter((target) => target.kind === 'strain');
  const unknown = targets.filter((target) => target.kind === 'stress');
  const build = (x: readonly number[]): Mat3 => {
    let F = guess;
    for (const target of strain)
      F = withEntry(F, target.component, ENTRY[target.component][0] === ENTRY[target.component][1] ? 1 + target.value : target.value);
    unknown.forEach((target, k) => {
      F = withEntry(F, target.component, x[k] ?? 0);
    });
    return F;
  };
  const evaluate = (x: readonly number[]): { response: FiniteResponse; r: number[] } | null => {
    const response = finiteResponse(law, build(x));
    return response === null ? null : { response, r: unknown.map((target) => stressOf(response, target.component) - target.value) };
  };
  let x = unknown.map((target) => entryOf(guess, target.component));
  let current = evaluate(x);
  if (current === null) return null;
  const tolerance = Math.max(RELATIVE_TOLERANCE * scale, 1e-13 * law.vol.bulkModulus);
  for (let iteration = 0; iteration < MAX_NEWTON; iteration += 1) {
    if (Math.max(0, ...current.r.map(Math.abs)) <= tolerance) return { F: build(x), response: current.response };
    const base: { response: FiniteResponse; r: number[] } = current;
    const jacobian: number[][] = unknown.map(() => new Array<number>(unknown.length).fill(0));
    for (let j = 0; j < x.length; j += 1) {
      const h = 1e-7 * Math.max(Math.abs(x[j] ?? 0), 1);
      const probe = evaluate(x.map((value, k) => (k === j ? value + h : value)));
      if (probe === null) return null;
      for (let i = 0; i < x.length; i += 1) (jacobian[i] as number[])[j] = ((probe.r[i] ?? 0) - (base.r[i] ?? 0)) / h;
    }
    const step = solveLinear(
      jacobian,
      base.r.map((value) => -value),
    );
    if (step === null) return null;
    const size = Math.max(0, ...base.r.map(Math.abs));
    let damping = 1;
    let next: { response: FiniteResponse; r: number[] } | null = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = x.map((value, k) => value + damping * (step[k] ?? 0));
      const trial = evaluate(candidate);
      if (trial !== null && Math.max(0, ...trial.r.map(Math.abs)) < size) {
        x = candidate;
        next = trial;
        break;
      }
      damping /= 2;
    }
    if (next === null) return null;
    current = next;
  }
  return Math.max(0, ...current.r.map(Math.abs)) <= tolerance * 10 ? { F: build(x), response: current.response } : null;
}

const rowOf = (response: FiniteResponse, step: number, increment: number, time: number, T: number | null): DriverRow => ({
  step,
  increment,
  time,
  T,
  strain: response.hencky,
  stress: response.stress,
  eqPlasticStrain: 0,
  vonMises: vonMises(response.stress),
  backStress: zero6(),
  energyDensity: response.energy,
  stretch: [...response.principal],
  nominalStress: response.nominal[0]?.[0] ?? 0,
  volumeRatio: response.volumeRatio,
});

/** Start value of a channel (the quantity it controls) at the beginning of a step. */
const startValue = (channel: Channel, component: Component, F: Mat3, response: FiniteResponse): number =>
  channel.kind === 'stress'
    ? stressOf(response, component)
    : ENTRY[component][0] === ENTRY[component][1]
      ? entryOf(F, component) - 1
      : entryOf(F, component);

/**
 * Run a general finite-strain path on a compressible law.
 * @failure invalid path / law -> MATL_PATH_INVALID / MATL_LAW_PARAMS_INVALID; det F ≤ 0 or Newton failure -> MATL_PATH_DIVERGED (step, increment)
 */
export function runCompressibleHyperelastic(input: CompressibleRunInput): DriverOutcome | DriverFailure {
  const invalidPath = pathProblem(input.steps, input.maxIncrements ?? MAX_TOTAL_INCREMENTS);
  if (invalidPath !== null) return invalidPath;
  const hyper = input.model.model as HyperLaw;
  const iso = resolveHyper(hyper);
  const vol = resolveVolumetric(hyper);
  if (iso === null)
    return failure('MATL_LAW_PARAMS_INVALID', `models.${input.model.id}`, 'the hyperelastic law does not resolve to numbers');
  if (isLawFailure(vol)) return vol;
  if (vol === null)
    return failure('MATL_PATH_INVALID', `models.${input.model.id}`, 'internal: an incompressible law reached the compressible driver');
  const law: CompressibleLaw = { iso, vol };
  const usedDefaults = new Set<string>(['newtonTolerance']);
  if (input.preset === undefined) usedDefaults.add('kinematicsPreset');
  const preset = input.preset ?? 'uniaxial_stress';
  const monitor = new ValidityMonitor([input.model]);
  const rows: DriverRow[] = [];
  let F: Mat3 = identity3();
  let response = finiteResponse(law, F);
  if (response === null) return fail('MATL_PATH_DIVERGED', 'the reference configuration has no valid response', 1);
  let time = 0;
  for (const [stepIndex, step] of input.steps.entries()) {
    const channels = buildChannels(step, preset);
    const duration = step.duration ?? DEFAULT_DURATION_SECONDS;
    if (step.duration === null) usedDefaults.add('stepDuration');
    const starts = COMPONENTS.map((component, c) => startValue(channels[c] as Channel, component, F, response as FiniteResponse));
    for (let k = 1; k <= step.increments; k += 1) {
      const fraction = k / step.increments;
      const targets: Target[] = COMPONENTS.map((component, c) => {
        const channel = channels[c] as Channel;
        const from = starts[c] ?? 0;
        return { component, kind: channel.kind, value: from + (channel.end - from) * fraction };
      });
      const scale = Math.max(
        iso.shearModulus * 1e-3,
        ...targets.filter((target) => target.kind === 'stress').map((target) => Math.abs(target.value)),
        ...response.stress.map(Math.abs),
      );
      const solved = solveIncrement(law, F, targets, scale);
      if (solved === null)
        return fail(
          'MATL_PATH_DIVERGED',
          'the deformation gradient became singular or the Newton iteration did not converge',
          stepIndex + 1,
          k,
        );
      F = solved.F;
      response = solved.response;
      const time1 = time + (duration * k) / step.increments;
      const [largest = 1, , smallest = 1] = response.principal;
      for (const stretch of [largest, smallest])
        monitor.check({ T: step.temperatureK, time: time1, eqPlasticStrain: 0, strainRate: 0, stretch }, stepIndex + 1, k);
      if (input.output === 'increments' || k === step.increments) rows.push(rowOf(response, stepIndex + 1, k, time1, step.temperatureK));
    }
    time += duration;
  }
  return { rows, warnings: monitor.warnings, issues: [], unverifiedReasons: [...monitor.reasons], reviewRequired: false, usedDefaults };
}
