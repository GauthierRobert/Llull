/** Start temperature of a transient coupled step and the pre-heating `*STATIC` step it implies (PHY-04 M4b). */

import type { ThermoMechSetup } from '@core/model/analysis';
import { inScale } from '../thermal/quantities';
import { temperatureIn } from './units';

/** Named deck rule: the period of the pre-heating `*STATIC` step. */
export const PREHEAT_PERIOD_S = 1;

type CoupledSetup = ThermoMechSetup & { readonly thermal: NonNullable<ThermoMechSetup['thermal']> };

/** Uniform start temperature (case scale) of a transient and whether it differs from the reference (then a pre-heating step is written). */
export function startOf(setup: CoupledSetup, reference: number, transient: boolean): { value: number; preheat: boolean } {
  const initial =
    transient && setup.thermal.initialTemperature !== undefined
      ? inScale(setup.thermal.initialTemperature, setup.temperatureScale)
      : reference;
  return { value: initial, preheat: Math.abs(initial - reference) > 1e-9 * Math.max(1, Math.abs(reference)) };
}

/** Period of the pre-heating step written before the coupled step of a transient case with this set-up, else 0. */
export function preheatPeriodS(setup: CoupledSetup): number {
  const reference = temperatureIn(setup.referenceTemperature, setup.temperatureScale);
  return reference !== null && startOf(setup, reference, true).preheat ? PREHEAT_PERIOD_S : 0;
}
