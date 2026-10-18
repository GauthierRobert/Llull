/** cycling_power: rider power <-> speed by the Martin et al. 1998 road model or the Bassett et al. 1999 velodrome model. */

import { defineCommand } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { toMetresPerSecond } from '../shared/speed';
import { refuseAero } from './codes';
import { cyclingParams } from './cyclingParams';
import { runBassett } from './cyclingBassett';
import { runMartin } from './cyclingMartin';

/**
 * @affects none; data = { model, speedMS, speedKmh, powerW, breakdown, distance1hKm, inputs (each with defaulted), warnings, provenance }
 * @invariant steady state (no acceleration); Martin: power at the cranks; Bassett: eq. 8 with M_t = rider + bike
 * @failure both / neither speed and powerW -> AER_SPEED_SOURCE_CONFLICT; missing / conflicting CdA source -> AER_AREA_SOURCE_CONFLICT; no steady speed -> AER_NO_EQUILIBRIUM
 */
export const cyclingPower = defineCommand({
  name: 'cycling_power',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only cycling power <-> speed. Give exactly one of `speed` (+ speedUnit, e.g. 45 km/h) or `powerW` (crank power, solves the ' +
    'steady speed). model `martin_1998` (default, road; Martin et al. 1998, validated R² 0.97, SE 2.7 W): total mass rider + bike ' +
    '`massKg`, drag area `cdA` m² (upright ≈ 0.27, drops ≈ 0.24, time-trial ≈ 0.21; Defraeye 2010) or `cd` + `entityIds` (frontal area ' +
    'of a rider + bike model), `crr` (default 0.0032), `gradePercent`, `headwindMS` (+ head / - tail), wheel area Fw 0.0044 m², chain ' +
    'efficiency 0.976, bearing loss 91 + 8.7·V mW; air from altitudeM (standard atmosphere) or densityKgM3. model `bassett_1999` ' +
    '(velodrome hour records; Bassett et al. 1999 eq. 8): `riderHeightM`, `riderMassKg`, bike 10 kg, aerodynamic factor `k1` (or the ' +
    'density ratio of `altitudeM` (or `densityKgM3` / 1.225) × position / bike / clothing / helmet factors), frontal area from height and mass. Returns the power ' +
    'breakdown (aero, rolling, bearings, gravity), speed, and the 1-hour distance; every defaulted input is flagged.',
  params: cyclingParams,
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = [], ids: string[] = []): CommandResult =>
      refuseAero(doc, 'cycling_power', code, message, ids, paths);
    if ((params.speed === undefined) === (params.powerW === undefined))
      return fail('AER_SPEED_SOURCE_CONFLICT', 'give exactly one of speed or powerW', ['speed']);
    const speedGiven = params.speed === undefined ? undefined : toMetresPerSecond(params.speed, params.speedUnit ?? 'm/s');
    if (
      (speedGiven !== undefined && !(speedGiven > 0 && speedGiven <= 40)) ||
      (params.powerW !== undefined && !(params.powerW > 0 && params.powerW <= 3000))
    )
      return fail('AER_PARAM_INVALID', 'speed must be within (0, 40] m/s and powerW within (0, 3000] W', ['speed']);
    const model = params.model ?? 'martin_1998';
    return model === 'bassett_1999' ? runBassett(doc, params, speedGiven, fail) : runMartin(doc, params, speedGiven, fail);
  },
});
