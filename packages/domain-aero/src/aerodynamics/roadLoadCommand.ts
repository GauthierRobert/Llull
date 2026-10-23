/** road_load_power: power <-> steady speed of a road vehicle (aero + rolling + grade + drivetrain), or the track-cycling hour-record model. */

import { defineCommand } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { toMetresPerSecond } from '../shared/speed';
import { refuseAero } from './codes';
import { MAX_GROUND_SPEED_MS } from './roadLoad';
import { roadLoadParams } from './roadLoadParams';
import { runBassett } from './roadLoadBassett';
import { runRoadLoad } from './roadLoadRun';

/** Largest power accepted (W): a heavy truck is ~ 500 kW. */
const MAX_POWER_W = 1e7;

/**
 * @affects none; data = { model, vehicle?, speedMS, speedKmh, powerW, breakdown, distance1hKm, inputs (each with defaulted), warnings, provenance }
 * @invariant steady state (no acceleration); road_load: power at the drivetrain input; bassett_1999: eq. 8 with M_t = rider + bike
 * @failure both / neither speed and powerW -> AER_SPEED_SOURCE_CONFLICT; missing / conflicting CdA source -> AER_AREA_SOURCE_CONFLICT; generic vehicle without crr -> AER_PARAM_INVALID; no steady speed -> AER_NO_EQUILIBRIUM
 */
export const roadLoadPowerCommand = defineCommand({
  name: 'road_load_power',
  annotations: { readsMeshTriangles: true, readOnly: true, idempotent: true },
  description:
    'Read-only power <-> steady speed of any road vehicle (bicycle, e-bike, car, truck): aerodynamic drag ½ρ(CdA+Fw)V_A²V, rolling ' +
    'resistance Crr·m·g·cos θ·V, climbing m·g·sin θ·V, wind and drivetrain efficiency. Give exactly one of `speed` (+ speedUnit) or ' +
    '`powerW` (drivetrain input power; the steady speed is solved). `vehicle` generic (default: `crr` required, no wheel / bearing terms, ' +
    'efficiency 1 = power at the wheels) or bicycle (Martin et al. 1998 road-cycling preset, validated R² 0.97, SE 2.7 W: Crr 0.0032, ' +
    'wheel drag Fw 0.0044 m², bearing loss V(91 + 8.7·V) mW, chain 0.976; rider + bike CdA upright ≈ 0.27, drops ≈ 0.24, time trial ≈ 0.21 ' +
    'm², Defraeye 2010). `massKg` total moving mass; drag area `cdA` m² or `cd` + `entityIds` (frontal area of the model); `gradePercent`; ' +
    '`headwindMS` (+ head / - tail); air from altitudeM (standard atmosphere) or densityKgM3. model `bassett_1999`: track-cycling hour ' +
    'records (Bassett et al. 1999 eq. 8, velodrome, no wind): `riderHeightM`, `riderMassKg`, bike 10 kg, aerodynamic factor `k1` (or the ' +
    'density ratio of `altitudeM` (or `densityKgM3` / 1.225) × position / bike / clothing / helmet factors). Returns the power breakdown ' +
    '(aero, rolling, bearings, gravity, drivetrain), speed and the 1-hour distance; every defaulted input is flagged.',
  params: roadLoadParams,
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = [], ids: string[] = []): CommandResult =>
      refuseAero(doc, 'road_load_power', code, message, ids, paths);
    if ((params.speed === undefined) === (params.powerW === undefined))
      return fail('AER_SPEED_SOURCE_CONFLICT', 'give exactly one of speed or powerW', ['speed']);
    const speedGiven = params.speed === undefined ? undefined : toMetresPerSecond(params.speed, params.speedUnit ?? 'm/s');
    if (
      (speedGiven !== undefined && !(speedGiven > 0 && speedGiven <= MAX_GROUND_SPEED_MS)) ||
      (params.powerW !== undefined && !(params.powerW > 0 && params.powerW <= MAX_POWER_W))
    )
      return fail('AER_PARAM_INVALID', `speed must be within (0, ${MAX_GROUND_SPEED_MS}] m/s and powerW within (0, ${MAX_POWER_W}] W`, [
        'speed',
      ]);
    return params.model === 'bassett_1999' ? runBassett(doc, params, speedGiven, fail) : runRoadLoad(doc, params, speedGiven, fail);
  },
});
