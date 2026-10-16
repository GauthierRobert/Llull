/** Material-point driver entry (PHY-02 §4): picks the small-strain, Ramberg-Osgood or finite-hyperelastic integrator for a set. */

import type { MaterialModel, SetSlot } from '../materialModel';
import type { PropertyRecord } from '../propertyModelEval';
import { runFiniteHyperelastic } from './driverFinite';
import { runRambergOsgoodPath } from './driverRo';
import { runSmallStrain } from './driverSmall';
import type { DriverFailure, DriverOutcome, PathStep, Preset } from './driverTypes';

export interface DriverRequest {
  readonly record: PropertyRecord;
  readonly slots: Readonly<Partial<Record<SetSlot, MaterialModel>>>;
  readonly kinematics: 'small' | 'finite';
  readonly preset: Preset | undefined;
  readonly steps: readonly PathStep[];
  readonly output: 'increments' | 'steps';
  /** Increment limit (default 100 000); the command never raises it. */
  readonly maxIncrements?: number | undefined;
}

const unsupported = (message: string): DriverFailure => ({
  code: 'MATL_PATH_INVALID',
  path: 'kinematics',
  message,
  remediation:
    "small strain for elasticity, plasticity, viscoelasticity, creep and Ramberg-Osgood; 'finite' for incompressible hyperelastic laws",
});

/**
 * Drive one material point.
 * @failure kinematics / law mismatch -> MATL_PATH_INVALID; see the integrators for the other codes
 */
export function runMaterialPoint(request: DriverRequest): DriverOutcome | DriverFailure {
  const { slots } = request;
  if (request.kinematics === 'finite') {
    if (slots.hyperelastic === undefined || Object.keys(slots).length !== 1)
      return unsupported('finite kinematics drives a set holding ONLY a hyperelastic model');
    return runFiniteHyperelastic({
      model: slots.hyperelastic,
      steps: request.steps,
      preset: request.preset,
      output: request.output,
      maxIncrements: request.maxIncrements,
    });
  }
  if (slots.hyperelastic !== undefined) return unsupported('a hyperelastic model needs kinematics finite');
  if (slots.plastic?.model.kind === 'ramberg_osgood') {
    if (slots.elastic !== undefined || slots.creep !== undefined || slots.viscoelastic !== undefined)
      return unsupported('ramberg_osgood runs alone (it carries E and ν)');
    return runRambergOsgoodPath({ ...request, plastic: slots.plastic });
  }
  return runSmallStrain(request);
}
