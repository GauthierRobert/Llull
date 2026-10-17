/** Ramberg-Osgood driver (PHY-02 §5.3): deformation theory, no history — each increment solves the mixed boundary problem directly. */

import type { LawOf, MaterialModel, SetSlot } from '../materialModel';
import { buildChannels, pathProblem } from './driverControl';
import {
  DEFAULT_DURATION_SECONDS,
  type DriverFailure,
  type DriverOutcome,
  type DriverRow,
  type DriverWarning,
  type PathStep,
  type Preset,
} from './driverTypes';
import { ValidityMonitor } from './driverValidity';
import { roLoadingDirection, roSolve, type RambergOsgoodMaterial, type RoTarget } from './rambergOsgood';
import { failure, isLawFailure, newTrace, resolveAll, type ResolveEnv } from './resolve';
import { contract, vonMises, zero6, type Vec6 } from './tensor';
import type { PropertyRecord } from '../propertyModelEval';

export interface RoRunInput {
  readonly record: PropertyRecord;
  readonly plastic: MaterialModel;
  readonly slots: Readonly<Partial<Record<SetSlot, MaterialModel>>>;
  readonly steps: readonly PathStep[];
  readonly preset: Preset | undefined;
  readonly output: 'increments' | 'steps';
  readonly maxIncrements?: number | undefined;
}

const workOf = (
  before: readonly number[],
  after: readonly number[],
  strainBefore: readonly number[],
  strainAfter: readonly number[],
): number => before.reduce((sum, value, i) => sum + 0.5 * (value + (after[i] ?? 0)) * ((strainAfter[i] ?? 0) - (strainBefore[i] ?? 0)), 0);

/**
 * Run a Ramberg-Osgood path.
 * @failure invalid path -> MATL_PATH_INVALID; unresolved parameters -> their code; no convergence -> MATL_PATH_DIVERGED
 * @invariant non-proportional loading or unloading raises MATL_DEFORMATION_THEORY_PATH (once per step)
 */
export function runRambergOsgoodPath(input: RoRunInput): DriverOutcome | DriverFailure {
  const invalid = pathProblem(input.steps, input.maxIncrements);
  if (invalid !== null) return invalid;
  const law = input.plastic.model as LawOf<'ramberg_osgood'>;
  const trace = newTrace();
  const rows: DriverRow[] = [];
  const warnings: DriverWarning[] = [];
  const usedDefaults = new Set<string>(['newtonTolerance']);
  const monitor = new ValidityMonitor(Object.values(input.slots));
  let stress: Vec6 = zero6();
  let strain: Vec6 = zero6();
  let work = 0;
  let time = 0;
  let reference: Vec6 | null = null;
  let previousEquivalent = 0;
  for (const [stepIndex, step] of input.steps.entries()) {
    const T = step.temperatureK;
    const env: ResolveEnv = { record: input.record, at: T === null ? {} : { T: { value: T, unit: 'K' } }, trace };
    const values = resolveAll(
      {
        E: { parameter: law.E, dimension: 'stress' },
        nu: { parameter: law.nu, dimension: 'dimensionless' },
        sigma0: { parameter: law.sigma0, dimension: 'stress' },
      },
      env,
      `models.${input.plastic.id}`,
    );
    if (isLawFailure(values)) return { ...values, step: stepIndex + 1 };
    const material: RambergOsgoodMaterial = { ...values, n: law.n, alpha: law.alpha };
    if (step.duration === null) usedDefaults.add('stepDuration');
    const duration = step.duration ?? DEFAULT_DURATION_SECONDS;
    const channels = buildChannels(step, input.preset);
    const start = channels.map((channel, c) => (channel.kind === 'strain' ? (strain[c] ?? 0) : (stress[c] ?? 0)));
    let warned = false;
    for (let k = 1; k <= step.increments; k += 1) {
      const fraction = k / step.increments;
      const targets: RoTarget[] = channels.map((channel, c) => ({
        kind: channel.kind,
        value: (start[c] ?? 0) + (channel.end - (start[c] ?? 0)) * fraction,
      }));
      const solution = roSolve(material, targets);
      if (solution === null)
        return {
          ...failure(
            'MATL_PATH_DIVERGED',
            `steps[${stepIndex}]`,
            'the Ramberg-Osgood Newton iteration did not converge',
            'use more increments; check the law',
          ),
          step: stepIndex + 1,
          increment: k,
        };
      work += workOf(stress, solution.stress, strain, solution.strain);
      stress = solution.stress;
      strain = solution.strain;
      const equivalent = vonMises(stress);
      const direction = roLoadingDirection(stress);
      reference ??= equivalent > 0 ? direction : null;
      const cosine = reference === null || equivalent === 0 ? 1 : contract(direction, reference);
      if (!warned && (cosine < 1 - 1e-6 || equivalent < previousEquivalent * (1 - 1e-9))) {
        warned = true;
        warnings.push({
          code: 'MATL_DEFORMATION_THEORY_PATH',
          step: stepIndex + 1,
          increment: k,
          message: 'non-proportional loading or unloading: the deformation theory is valid for monotonic proportional loading only',
        });
      }
      previousEquivalent = equivalent;
      const time1 = time + (duration * k) / step.increments;
      const plasticEquivalent = (material.alpha / material.E) * (equivalent / material.sigma0) ** (material.n - 1) * equivalent;
      monitor.check({ T, time: time1, eqPlasticStrain: plasticEquivalent, strainRate: 0, stretch: null }, stepIndex + 1, k);
      if (input.output === 'increments' || k === step.increments)
        rows.push({
          step: stepIndex + 1,
          increment: k,
          time: time1,
          T,
          strain,
          stress,
          eqPlasticStrain: plasticEquivalent,
          vonMises: equivalent,
          backStress: zero6(),
          energyDensity: work,
        });
    }
    time += duration;
  }
  return {
    rows,
    warnings: [...monitor.warnings, ...warnings],
    issues: [],
    unverifiedReasons: [...trace.unverifiedReasons, ...monitor.reasons],
    reviewRequired: trace.reviewRequired,
    usedDefaults,
  };
}
