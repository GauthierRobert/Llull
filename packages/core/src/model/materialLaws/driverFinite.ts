/**
 * Finite-strain driver for incompressible hyperelastic laws in homogeneous modes (PHY-02 §5.6): uniaxial_stress, equibiaxial, pure_shear.
 * `xx` controls the mode by a nominal strain (λ − 1) or a nominal stress (MPa, solved for λ). Compressible laws (D1 > 0) go to `driverCompressible`.
 */

import type { MaterialModel } from '../materialModel';
import {
  DEFAULT_DURATION_SECONDS,
  MAX_TOTAL_INCREMENTS,
  type DriverFailure,
  type DriverOutcome,
  type DriverRow,
  type PathStep,
  type Preset,
} from './driverTypes';
import { runCompressibleHyperelastic } from './driverCompressible';
import { ValidityMonitor } from './driverValidity';
import { cauchyStresses, modeStretches, nominalStress, strainEnergy, type HyperMode, type ResolvedHyper } from './hyperelastic';
import { isIncompressible, resolveHyper, type HyperLaw } from './hyperResolve';
import { failure } from './resolve';
import { vonMises, zero6 } from './tensor';

export interface FiniteRunInput {
  readonly model: MaterialModel;
  readonly steps: readonly PathStep[];
  readonly preset: Preset | undefined;
  readonly output: 'increments' | 'steps';
  readonly maxIncrements?: number | undefined;
}

const MODE_OF: Readonly<Partial<Record<Preset, HyperMode>>> = { uniaxial_stress: 'UT', equibiaxial: 'ET', pure_shear: 'PS' };

const invalid = (path: string, message: string): DriverFailure => ({
  code: 'MATL_PATH_INVALID',
  path,
  message,
  remediation:
    'finite hyperelastic runs control xx only (nominal strain λ − 1 or nominal stress) with preset uniaxial_stress, equibiaxial or pure_shear',
});

/** λ with P(λ) = target by bisection on a bracket grown geometrically from 1. */
function stretchForNominalStress(law: ResolvedHyper, mode: HyperMode, target: number): number | null {
  const f = (lambda: number): number => nominalStress(law, mode, lambda) - target;
  let a = 1;
  let b = 1;
  if (target >= 0) {
    for (let i = 0; i < 80 && f(b) < 0; i += 1) b *= 1.5;
    if (f(b) < 0) return null;
  } else {
    for (let i = 0; i < 80 && f(a) > 0; i += 1) a /= 1.5;
    if (f(a) > 0) return null;
  }
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (a + b);
    if (f(a) * f(mid) <= 0) b = mid;
    else a = mid;
  }
  return 0.5 * (a + b);
}

/**
 * Run a finite-strain homogeneous-mode path.
 * @failure control other than xx / unknown preset / incompressible law with another control -> MATL_PATH_INVALID; unreachable stress -> MATL_PATH_DIVERGED
 */
export function runFiniteHyperelastic(input: FiniteRunInput): DriverOutcome | DriverFailure {
  const law = input.model.model as HyperLaw;
  const usedDefaults = new Set<string>();
  if (!isIncompressible(law)) return runCompressibleHyperelastic(input);
  const preset = input.preset ?? 'uniaxial_stress';
  if (input.preset === undefined) usedDefaults.add('kinematicsPreset');
  const mode = MODE_OF[preset];
  if (mode === undefined) return invalid('preset', `preset '${preset}' is not a hyperelastic mode`);
  const resolved = resolveHyper(law);
  if (resolved === null)
    return failure('MATL_LAW_PARAMS_INVALID', `models.${input.model.id}`, 'the hyperelastic law does not resolve to numbers');
  let total = 0;
  for (const [i, step] of input.steps.entries()) {
    if (!Number.isInteger(step.increments) || step.increments < 1)
      return invalid(`steps[${i}].increments`, 'increments must be an integer ≥ 1');
    total += step.increments;
    const keys = Object.keys(step.control);
    if (keys.length !== 1 || keys[0] !== 'xx') return invalid(`steps[${i}].control`, 'control xx only');
  }
  if (input.steps.length === 0 || total > (input.maxIncrements ?? MAX_TOTAL_INCREMENTS))
    return invalid('steps', 'need 1 or more steps and at most the increment limit');
  const monitor = new ValidityMonitor([input.model]);
  const rows: DriverRow[] = [];
  let lambda = 1;
  let time = 0;
  for (const [stepIndex, step] of input.steps.entries()) {
    const control = step.control.xx;
    if (control === undefined) continue;
    const duration = step.duration ?? DEFAULT_DURATION_SECONDS;
    if (step.duration === null) usedDefaults.add('stepDuration');
    const startLambda = lambda;
    const startNominal = nominalStress(resolved, mode, lambda);
    for (let k = 1; k <= step.increments; k += 1) {
      const fraction = k / step.increments;
      const next =
        'strain' in control
          ? startLambda + (1 + control.strain - startLambda) * fraction
          : stretchForNominalStress(resolved, mode, startNominal + (control.stress - startNominal) * fraction);
      if (next === null || !(next > 0))
        return {
          ...invalid(`steps[${stepIndex}]`, 'the nominal stress target is not reachable'),
          code: 'MATL_PATH_DIVERGED',
          step: stepIndex + 1,
          increment: k,
        };
      lambda = next;
      const stretches = modeStretches(mode, lambda);
      const cauchy = cauchyStresses(resolved, stretches);
      const stress = [cauchy[0], cauchy[1], cauchy[2], 0, 0, 0];
      const time1 = time + (duration * k) / step.increments;
      monitor.check({ T: step.temperatureK, time: time1, eqPlasticStrain: 0, strainRate: 0, stretch: lambda }, stepIndex + 1, k);
      if (input.output === 'increments' || k === step.increments)
        rows.push({
          step: stepIndex + 1,
          increment: k,
          time: time1,
          T: step.temperatureK,
          strain: [Math.log(stretches[0]), Math.log(stretches[1]), Math.log(stretches[2]), 0, 0, 0],
          stress,
          eqPlasticStrain: 0,
          vonMises: vonMises(stress),
          backStress: zero6(),
          energyDensity: strainEnergy(resolved, stretches),
          stretch: [...stretches],
          nominalStress: nominalStress(resolved, mode, lambda),
        });
    }
    time += duration;
  }
  return { rows, warnings: monitor.warnings, issues: [], unverifiedReasons: [...monitor.reasons], reviewRequired: false, usedDefaults };
}
