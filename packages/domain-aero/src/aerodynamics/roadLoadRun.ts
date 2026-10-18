/** road_load_power, model road_load: power <-> steady speed of a road vehicle (Martin et al. 1998 terms; bicycle preset). */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { briefReport, sig } from '../shared/results';
import { isAirState, resolveAirState } from '../shared/airState';
import { geometryArea } from './geometryArea';
import { BICYCLE_DEFAULTS, MAX_GROUND_SPEED_MS, roadLoadPower, roadLoadSpeed, type RoadLoadInputs } from './roadLoad';
import type { RoadLoadInput, RoadLoadRefusal } from './roadLoadParams';

/** Defaults of each vehicle preset; a generic vehicle has no sourced rolling resistance, so crr is required. */
const PRESETS = {
  generic: { crr: undefined, wheelAreaM2: 0, drivetrainEfficiency: 1, bearingLosses: false },
  bicycle: { ...BICYCLE_DEFAULTS, bearingLosses: true },
} as const;

const kmh = (ms: number): number => ms * 3.6;

/**
 * @failure missing mass, generic vehicle without crr, ambiguous CdA source, out-of-range inputs, no steady speed -> AER_* through `fail`
 */
export function runRoadLoad(doc: CadDocument, params: RoadLoadInput, speedGiven: number | undefined, fail: RoadLoadRefusal): CommandResult {
  const vehicle = params.vehicle ?? 'generic';
  const preset = PRESETS[vehicle];
  if (params.massKg === undefined || !(params.massKg > 0 && params.massKg < 1e6))
    return fail('AER_PARAM_INVALID', 'road_load needs massKg (total moving mass) in (0, 1e6) kg', ['massKg']);
  const crr = params.crr ?? preset.crr;
  if (crr === undefined)
    return fail(
      'AER_PARAM_INVALID',
      'a generic vehicle needs crr (rolling resistance coefficient from tyre data); vehicle bicycle has a sourced default',
      ['crr'],
    );
  const areaSources = [params.cdA !== undefined, params.entityIds !== undefined].filter(Boolean).length;
  if (areaSources !== 1 || (params.entityIds !== undefined && params.cd === undefined))
    return fail('AER_AREA_SOURCE_CONFLICT', 'give cdA, or cd + entityIds', ['cdA']);
  let cdA = params.cdA as number;
  let frontal: number | undefined;
  if (params.entityIds !== undefined) {
    if (!(params.cd !== undefined && params.cd > 0)) return fail('AER_PARAM_INVALID', 'cd must be > 0', ['cd']);
    const measured = geometryArea(doc, params.entityIds, params.flowDirection, params.resolution);
    if (!measured.ok) return fail(measured.code, measured.message, [measured.path], [...measured.ids]);
    frontal = measured.area.area;
    cdA = params.cd * frontal;
  }
  const grade = (params.gradePercent ?? 0) / 100;
  const input: RoadLoadInputs = {
    massKg: params.massKg,
    cdA,
    crr,
    wheelAreaM2: params.wheelAreaM2 ?? preset.wheelAreaM2,
    drivetrainEfficiency: params.drivetrainEfficiency ?? preset.drivetrainEfficiency,
    grade,
    headwindMS: params.headwindMS ?? 0,
    densityKgM3: 0,
    bearingLosses: params.bearingLosses ?? preset.bearingLosses,
  };
  if (
    !(cdA > 0) ||
    !(input.crr >= 0 && input.crr < 0.1) ||
    !(input.wheelAreaM2 >= 0) ||
    !(input.drivetrainEfficiency > 0 && input.drivetrainEfficiency <= 1) ||
    !(Math.abs(grade) <= 0.25) ||
    !Number.isFinite(input.headwindMS)
  )
    return fail(
      'AER_PARAM_INVALID',
      'cdA > 0, crr 0..0.1, wheelAreaM2 >= 0, drivetrainEfficiency (0, 1], gradePercent -25..25, finite headwindMS',
      ['cdA'],
    );
  const air = resolveAirState(params);
  if (!isAirState(air)) return fail(air.code, air.message, ['altitudeM']);
  const withAir = { ...input, densityKgM3: air.densityKgM3 };
  const speed = speedGiven ?? roadLoadSpeed(withAir, params.powerW as number);
  if (speed === null)
    return fail('AER_NO_EQUILIBRIUM', `no steady speed up to ${MAX_GROUND_SPEED_MS} m/s needs ${params.powerW} W`, ['powerW']);
  const power = roadLoadPower(withAir, speed);
  const flag = (value: number, given: number | undefined): { value: number; defaulted: boolean } => ({
    value,
    defaulted: given === undefined,
  });
  const data = {
    model: 'road_load',
    vehicle,
    speedMS: sig(speed),
    speedKmh: sig(kmh(speed)),
    powerW: sig(power.totalW),
    distance1hKm: sig(kmh(speed)),
    breakdown: {
      aeroW: sig(power.aeroW),
      rollingW: sig(power.rollingW),
      bearingW: sig(power.bearingW),
      gravityW: sig(power.gravityW),
      drivetrainLossW: sig(power.totalW * (1 - withAir.drivetrainEfficiency)),
    },
    inputs: {
      massKg: params.massKg,
      cdA: { value: sig(cdA), source: frontal === undefined ? 'given' : `cd ${params.cd} x frontal area ${sig(frontal)} m²` },
      crr: flag(withAir.crr, params.crr),
      wheelAreaM2: flag(withAir.wheelAreaM2, params.wheelAreaM2),
      drivetrainEfficiency: flag(withAir.drivetrainEfficiency, params.drivetrainEfficiency),
      bearingLosses: withAir.bearingLosses,
      gradePercent: params.gradePercent ?? 0,
      headwindMS: withAir.headwindMS,
      air: { densityKgM3: sig(air.densityKgM3), source: air.source, defaulted: air.defaulted },
    },
    warnings: [
      ...(power.gravityW + power.aeroW + power.rollingW + power.bearingW < 0
        ? ['Net resistance is negative: the vehicle coasts faster than this.']
        : []),
      'Steady state only (no acceleration term); gravity g = 9.80665 m/s².',
    ],
    provenance: {
      formulas: {
        power: 'P = [½ρ(CdA+Fw)V_A²V_G + V_G Crr m g cos(atan G) + bearings + V_G m g sin(atan G)] / η (Martin et al. 1998)',
        ...(withAir.bearingLosses ? { bearings: 'V_G(91 + 8.7 V_G)·1e-3 W (Dahn 1991 via Martin 1998, bicycle wheels)' } : {}),
      },
    },
  };
  return briefReport(
    doc,
    `road_load_power ${vehicle}: ${data.speedKmh} km/h <-> ${data.powerW} W at the drivetrain input (aero ${data.breakdown.aeroW}, rolling ${data.breakdown.rollingW}, ` +
      `bearings ${data.breakdown.bearingW}, gravity ${data.breakdown.gravityW} W; CdA ${data.inputs.cdA.value} m², ρ ${data.inputs.air.densityKgM3}).`,
    data,
  );
}
