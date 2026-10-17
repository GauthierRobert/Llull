/** Path control of the material-point driver (PHY-02 §4, §5.3): presets and per-step channels. */

import { COMPONENTS, MAX_TOTAL_INCREMENTS, type Component, type DriverFailure, type PathStep, type Preset } from './driverTypes';

export interface Channel {
  readonly kind: 'strain' | 'stress';
  /** Target at the end of the step (strain, or MPa). */
  readonly end: number;
}

/** Components a preset holds at zero strain unless the step controls them. */
const FIXED_STRAIN: Readonly<Record<Preset, readonly Component[]>> = {
  uniaxial_stress: [],
  uniaxial_strain: ['yy', 'zz', 'xy', 'xz', 'yz'],
  plane_strain: ['zz', 'xz', 'yz'],
  equibiaxial: ['xy', 'xz', 'yz'],
  pure_shear: ['yy', 'xy', 'xz', 'yz'],
  simple_shear: ['xx', 'yy', 'zz', 'xz', 'yz'],
};

/**
 * The six channels of a step: the step's own control first; then the preset (equibiaxial ties yy to xx; the fixed components are held at
 * zero strain); everything else is stress-free (σ = 0).
 */
export function buildChannels(step: PathStep, preset: Preset | undefined): Channel[] {
  const fixed = preset === undefined ? [] : FIXED_STRAIN[preset];
  return COMPONENTS.map((component): Channel => {
    const own = step.control[component];
    if (own !== undefined) return 'strain' in own ? { kind: 'strain', end: own.strain } : { kind: 'stress', end: own.stress };
    if (preset === 'equibiaxial' && component === 'yy') {
      const xx = step.control.xx;
      if (xx !== undefined) return 'strain' in xx ? { kind: 'strain', end: xx.strain } : { kind: 'stress', end: xx.stress };
    }
    return fixed.includes(component) ? { kind: 'strain', end: 0 } : { kind: 'stress', end: 0 };
  });
}

const fail = (path: string, message: string): DriverFailure => ({
  code: 'MATL_PATH_INVALID',
  path,
  message,
  remediation: 'control each component by strain or stress, once; give 1 or more increments per step',
});

/** First structural problem of the path, or null. */
export function pathProblem(steps: readonly PathStep[], limit = MAX_TOTAL_INCREMENTS): DriverFailure | null {
  if (steps.length === 0) return fail('steps', 'need at least one step');
  let total = 0;
  for (const [i, step] of steps.entries()) {
    if (!Number.isInteger(step.increments) || step.increments < 1)
      return fail(`steps[${i}].increments`, 'increments must be an integer ≥ 1');
    if (step.duration !== null && !(step.duration > 0 && Number.isFinite(step.duration)))
      return fail(`steps[${i}].duration`, 'duration must be a finite time > 0');
    for (const [component, control] of Object.entries(step.control)) {
      if (!(COMPONENTS as readonly string[]).includes(component))
        return fail(`steps[${i}].control.${component}`, `unknown component '${component}'`);
      const value = 'strain' in control ? control.strain : control.stress;
      if (!Number.isFinite(value)) return fail(`steps[${i}].control.${component}`, 'target must be a finite number');
    }
    total += step.increments;
  }
  return total > limit ? fail('steps', `${total} increments exceed the limit of ${limit}`) : null;
}
