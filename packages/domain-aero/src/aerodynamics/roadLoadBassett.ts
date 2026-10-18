/** road_load_power, model bassett_1999: track-cycling power <-> speed (Bassett et al. 1999 eq. 5, 7, 8). */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { briefReport, sig } from '../shared/results';
import { bassettDensityRatio, bassettFrontalArea, bassettPower, bassettSpeed } from './roadLoad';
import type { RoadLoadInput, RoadLoadRefusal } from './roadLoadParams';

/** Sea-level density of the 1976 standard (kg/m³): Kd = ρ / ρ0 when bassett_1999 gets densityKgM3. */
const SEA_LEVEL_DENSITY = 1.225;

const kmh = (ms: number): number => ms * 3.6;

/**
 * @failure missing / out-of-range rider, unused air params, bad factors -> AER_PARAM_INVALID / AER_AIR_STATE_CONFLICT through `fail`
 */
export function runBassett(doc: CadDocument, params: RoadLoadInput, speedGiven: number | undefined, fail: RoadLoadRefusal): CommandResult {
  const { riderHeightM: height, riderMassKg: mass } = params;
  if (height === undefined || mass === undefined || !(height >= 1.4 && height <= 2.2) || !(mass >= 40 && mass <= 120))
    return fail('AER_PARAM_INVALID', 'bassett_1999 needs riderHeightM 1.4..2.2 m and riderMassKg 40..120 kg', ['riderHeightM']);
  if (params.temperatureOffsetK !== undefined || params.viscosityPaS !== undefined)
    return fail('AER_PARAM_INVALID', 'bassett_1999 uses altitudeM (eq. 5 density ratio) or densityKgM3 only', ['temperatureOffsetK']);
  if (params.altitudeM !== undefined && params.densityKgM3 !== undefined)
    return fail('AER_AIR_STATE_CONFLICT', 'altitudeM and densityKgM3 both given', ['altitudeM']);
  if (
    (params.altitudeM !== undefined && !(params.altitudeM >= -500 && params.altitudeM <= 5000)) ||
    (params.densityKgM3 !== undefined && !(params.densityKgM3 > 0))
  )
    return fail('AER_PARAM_INVALID', 'bassett_1999 altitudeM must be within -500..5000 m and densityKgM3 > 0', ['altitudeM']);
  const factors = {
    kd:
      params.densityKgM3 !== undefined
        ? params.densityKgM3 / SEA_LEVEL_DENSITY
        : params.altitudeM === undefined
          ? 1
          : bassettDensityRatio(params.altitudeM),
    kpo: params.positionFactor ?? 1,
    kb: params.bikeFactor ?? 1,
    kc: params.clothingFactor ?? 1,
    kh: params.helmetFactor ?? 1,
  };
  const k1 = params.k1 ?? factors.kd * factors.kpo * factors.kb * factors.kc * factors.kh;
  const k = params.trackFactor ?? 1;
  const bike = params.bikeMassKg ?? 10;
  if (![k1, k, bike].every((value) => value > 0 && value < 100))
    return fail('AER_PARAM_INVALID', 'k1, trackFactor and bikeMassKg must be > 0', ['k1']);
  const input = { riderHeightM: height, riderMassKg: mass, bikeMassKg: bike, k1, k };
  const speedKmh = speedGiven === undefined ? bassettSpeed(input, params.powerW as number) : kmh(speedGiven);
  const powerW = bassettPower(input, speedKmh);
  const data = {
    model: 'bassett_1999',
    speedMS: sig(speedKmh / 3.6),
    speedKmh: sig(speedKmh),
    powerW: sig(powerW),
    distance1hKm: sig(speedKmh),
    breakdown: {
      rollingW: sig(k * 0.00953 * (mass + bike) * speedKmh),
      speedSquaredW: sig(k * 0.00775 * speedKmh ** 2),
      aeroW: sig(k * k1 * bassettFrontalArea(height, mass) * 0.007551 * speedKmh ** 3),
    },
    inputs: {
      riderHeightM: height,
      riderMassKg: mass,
      bikeMassKg: { value: bike, defaulted: params.bikeMassKg === undefined },
      frontalAreaM2: sig(bassettFrontalArea(height, mass)),
      k1: {
        value: sig(k1),
        defaulted: [
          params.k1,
          params.altitudeM,
          params.densityKgM3,
          params.positionFactor,
          params.bikeFactor,
          params.clothingFactor,
          params.helmetFactor,
        ].every((value) => value === undefined),
        factors,
      },
      trackFactor: { value: k, defaulted: params.trackFactor === undefined },
    },
    warnings: ['Velodrome model (no wind, track rolling resistance); power estimates are about ±4 % (Bassett 1999).'],
    provenance: {
      formulas: {
        power: 'P = K (0.00953 M_t V + 0.00775 V² + K1 A_f 0.007551 V³), V km/h (Bassett 1999 eq. 8)',
        frontalArea: 'A_f = 0.0293 H^0.725 M^0.425 + 0.0604 m² (eq. 7)',
        densityRatio: 'Kd = [1 - g(n-1)z/(nRT1)]^(1/(n-1)), n 1.235 (eq. 5)',
      },
    },
  };
  return briefReport(
    doc,
    `road_load_power bassett_1999: ${data.speedKmh} km/h <-> ${data.powerW} W (K1 ${data.inputs.k1.value}, A_f ${data.inputs.frontalAreaM2} m²).`,
    data,
  );
}
