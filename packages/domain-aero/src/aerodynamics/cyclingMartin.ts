/** cycling_power, model martin_1998: road power <-> speed (Martin et al. 1998, steady state). */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { briefReport, sig } from '../shared/results';
import { isAirState, resolveAirState } from '../shared/airState';
import { geometryArea } from './geometryArea';
import { MARTIN_DEFAULTS, martinPower, martinSpeed, type MartinInputs } from './cycling';
import type { CyclingInput, CyclingRefusal } from './cyclingParams';

const kmh = (ms: number): number => ms * 3.6;

/**
 * @failure missing mass, ambiguous CdA source, out-of-range inputs, no steady speed -> AER_* through `fail`
 */
export function runMartin(doc: CadDocument, params: CyclingInput, speedGiven: number | undefined, fail: CyclingRefusal): CommandResult {
  if (params.massKg === undefined || !(params.massKg > 0 && params.massKg < 400))
    return fail('AER_PARAM_INVALID', 'martin_1998 needs massKg (rider + bike) in (0, 400)', ['massKg']);
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
  const input: MartinInputs = {
    massKg: params.massKg,
    cdA,
    crr: params.crr ?? MARTIN_DEFAULTS.crr,
    wheelAreaM2: params.wheelAreaM2 ?? MARTIN_DEFAULTS.wheelAreaM2,
    chainEfficiency: params.chainEfficiency ?? MARTIN_DEFAULTS.chainEfficiency,
    grade,
    headwindMS: params.headwindMS ?? 0,
    densityKgM3: 0,
    bearingLosses: params.bearingLosses ?? true,
  };
  if (
    !(cdA > 0) ||
    !(input.crr >= 0 && input.crr < 0.1) ||
    !(input.wheelAreaM2 >= 0) ||
    !(input.chainEfficiency > 0 && input.chainEfficiency <= 1) ||
    !(Math.abs(grade) <= 0.25) ||
    !Number.isFinite(input.headwindMS)
  )
    return fail(
      'AER_PARAM_INVALID',
      'cdA > 0, crr 0..0.1, wheelAreaM2 >= 0, chainEfficiency (0, 1], gradePercent -25..25, finite headwindMS',
      ['cdA'],
    );
  const air = resolveAirState(params);
  if (!isAirState(air)) return fail(air.code, air.message, ['altitudeM']);
  const withAir = { ...input, densityKgM3: air.densityKgM3 };
  const speed = speedGiven ?? martinSpeed(withAir, params.powerW as number);
  if (speed === null) return fail('AER_NO_EQUILIBRIUM', `no steady speed up to 40 m/s needs ${params.powerW} W`, ['powerW']);
  const power = martinPower(withAir, speed);
  const flag = (value: number, given: number | undefined): { value: number; defaulted: boolean } => ({
    value,
    defaulted: given === undefined,
  });
  const data = {
    model: 'martin_1998',
    speedMS: sig(speed),
    speedKmh: sig(kmh(speed)),
    powerW: sig(power.totalW),
    distance1hKm: sig(kmh(speed)),
    breakdown: {
      aeroW: sig(power.aeroW),
      rollingW: sig(power.rollingW),
      bearingW: sig(power.bearingW),
      gravityW: sig(power.gravityW),
      drivetrainLossW: sig(power.totalW * (1 - withAir.chainEfficiency)),
    },
    inputs: {
      massKg: params.massKg,
      cdA: { value: sig(cdA), source: frontal === undefined ? 'given' : `cd ${params.cd} x frontal area ${sig(frontal)} m²` },
      crr: flag(withAir.crr, params.crr),
      wheelAreaM2: flag(withAir.wheelAreaM2, params.wheelAreaM2),
      chainEfficiency: flag(withAir.chainEfficiency, params.chainEfficiency),
      gradePercent: params.gradePercent ?? 0,
      headwindMS: withAir.headwindMS,
      air: { densityKgM3: sig(air.densityKgM3), source: air.source, defaulted: air.defaulted },
    },
    warnings: [
      ...(power.gravityW + power.aeroW + power.rollingW + power.bearingW < 0
        ? ['Net resistance is negative: the rider coasts faster than this.']
        : []),
      'Steady state only (no acceleration term); gravity g = 9.80665 m/s².',
    ],
    provenance: {
      formulas: {
        power: 'P = [½ρ(CdA+Fw)V_A²V_G + V_G Crr m g cos(atan G) + V_G(91+8.7V_G)e-3 + V_G m g sin(atan G)] / E_c (Martin et al. 1998)',
      },
    },
  };
  return briefReport(
    doc,
    `cycling_power martin_1998: ${data.speedKmh} km/h <-> ${data.powerW} W at the cranks (aero ${data.breakdown.aeroW}, rolling ${data.breakdown.rollingW}, ` +
      `bearings ${data.breakdown.bearingW}, gravity ${data.breakdown.gravityW} W; CdA ${data.inputs.cdA.value} m², ρ ${data.inputs.air.densityKgM3}).`,
    data,
  );
}
