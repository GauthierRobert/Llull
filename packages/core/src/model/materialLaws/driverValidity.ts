/** Validity monitoring of the driver (PHY-02 §5.9): the first observation outside a model's validity range per (model, variable). */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import type { MaterialModel, MaterialValidityVariable } from '../materialModel';
import type { DriverWarning } from './driverTypes';
import { VALIDITY_BASE_UNIT } from './validity';

export interface Observation {
  readonly T: number | null;
  readonly time: number;
  readonly eqPlasticStrain: number;
  readonly strainRate: number;
  readonly stretch: number | null;
}

const observed = (variable: MaterialValidityVariable, observation: Observation): number | null => {
  switch (variable) {
    case 'T':
      return observation.T;
    case 'time':
      return observation.time;
    case 'strainRate':
      return observation.strainRate;
    case 'equivalentPlasticStrain':
      return observation.eqPlasticStrain;
    case 'stretch':
      return observation.stretch;
    default:
      return null;
  }
};

export class ValidityMonitor {
  readonly warnings: DriverWarning[] = [];
  readonly reasons = new Set<string>();
  private readonly reported = new Set<string>();

  constructor(private readonly models: readonly MaterialModel[]) {}

  check(observation: Observation, step: number, increment: number): void {
    for (const model of this.models) {
      for (const range of model.validity ?? []) {
        const key = `${model.id}|${range.variable}`;
        if (this.reported.has(key)) continue;
        const value = observed(range.variable, observation);
        if (value === null) continue;
        const [lowRaw, highRaw] = range.equation ?? range.data;
        const low = convertValue(lowRaw, range.unit, VALIDITY_BASE_UNIT[range.variable]);
        const high = convertValue(highRaw, range.unit, VALIDITY_BASE_UNIT[range.variable]);
        if (isUnitFailure(low) || isUnitFailure(high)) continue;
        const tolerance = 1e-12 * Math.max(1, Math.abs(value));
        if (value < low.value - tolerance || value > high.value + tolerance) {
          this.reported.add(key);
          this.reasons.add(`state outside the validity of model '${model.id}' (${range.variable})`);
          this.warnings.push({
            code: 'MATL_STRAIN_OUT_OF_RANGE',
            step,
            increment,
            message: `${range.variable} = ${value} is outside [${low.value}, ${high.value}] ${VALIDITY_BASE_UNIT[range.variable]} of model '${model.id}': results are extrapolated`,
          });
        }
      }
    }
  }
}
