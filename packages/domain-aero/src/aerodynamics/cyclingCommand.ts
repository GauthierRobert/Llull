/** cycling_power: rider power <-> speed by the Martin et al. 1998 road model or the Bassett et al. 1999 velodrome model. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { roundSignificant } from '@lib/significant';
import { briefReport } from './brief';
import { refuseAero } from './codes';
import { airStateParams, isAirState, resolveAirState } from './airState';
import { speedParam, toMetresPerSecond } from './speed';
import { DEFAULT_FLOW_DIRECTION, DEFAULT_RESOLUTION, geometryArea } from './geometryArea';
import {
  bassettDensityRatio,
  bassettFrontalArea,
  bassettPower,
  bassettSpeed,
  MARTIN_DEFAULTS,
  martinPower,
  martinSpeed,
  type MartinInputs,
} from './cycling';

const sig = (value: number): number => roundSignificant(value, 10);

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
    'density ratio of `altitudeM` × position / bike / clothing / helmet factors), frontal area from height and mass. Returns the power ' +
    'breakdown (aero, rolling, bearings, gravity), speed, and the 1-hour distance; every defaulted input is flagged.',
  params: z.object({
    model: z.enum(['martin_1998', 'bassett_1999']).optional().describe('martin_1998 (default, road) or bassett_1999 (track hour record).'),
    ...speedParam,
    powerW: z.number().optional().describe('Crank power in W (> 0); the command solves the steady speed. Give this or speed.'),
    massKg: z.number().optional().describe('martin: total mass rider + bicycle + kit in kg (> 0). Required.'),
    cdA: z.number().optional().describe('martin: drag area CdA in m² (> 0). Or cd + entityIds.'),
    cd: z.number().optional().describe('martin: drag coefficient on the frontal area of entityIds.'),
    entityIds: z
      .array(z.string())
      .optional()
      .describe('martin: rider + bicycle solids; frontal area along flowDirection (default [1, 0, 0]).'),
    flowDirection: z
      .array(z.number())
      .length(3)
      .optional()
      .describe('Air direction relative to the rider for entityIds. Default [1, 0, 0].'),
    crr: z.number().optional().describe('martin: rolling resistance coefficient (default 0.0032, Martin 1998 road tyres).'),
    gradePercent: z.number().optional().describe('martin: road grade in % (rise / run × 100, -25..25). Default 0.'),
    headwindMS: z.number().optional().describe('martin: wind along the road in m/s, + headwind / - tailwind. Default 0.'),
    wheelAreaM2: z.number().optional().describe('martin: wheel rotation drag area Fw in m² (default 0.0044).'),
    chainEfficiency: z.number().optional().describe('martin: drivetrain efficiency E_c in (0, 1] (default 0.976).'),
    bearingLosses: z.boolean().optional().describe('martin: include wheel-bearing friction 91 + 8.7·V mW per m/s (default true).'),
    riderHeightM: z.number().optional().describe('bassett: rider height in m (1.4..2.2). Required.'),
    riderMassKg: z.number().optional().describe('bassett: rider mass in kg (40..120). Required.'),
    bikeMassKg: z.number().optional().describe('bassett: bicycle mass in kg (default 10, the paper value).'),
    k1: z.number().optional().describe('bassett: aerodynamic factor K1 = Kd·Kpo·Kb·Kc·Kh (overrides the factors below).'),
    positionFactor: z
      .number()
      .optional()
      .describe('bassett: Kpo (e.g. 1.0 aero bars, 0.95 Superman, 0.96 Obree, 1.08 drop bars). Default 1.'),
    bikeFactor: z.number().optional().describe('bassett: Kb (0.93 aero bike, 1.07 drop bars + spoked wheels). Default 1.'),
    clothingFactor: z.number().optional().describe('bassett: Kc (1.02-1.09 wool). Default 1.'),
    helmetFactor: z.number().optional().describe('bassett: Kh (1.025-1.04 no aero helmet). Default 1.'),
    trackFactor: z.number().optional().describe('bassett: K, external conditions (track roughness). Default 1.'),
    ...airStateParams,
  }),
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
    const kmh = (ms: number): number => ms * 3.6;
    if (model === 'bassett_1999') {
      const { riderHeightM: height, riderMassKg: mass } = params;
      if (height === undefined || mass === undefined || !(height >= 1.4 && height <= 2.2) || !(mass >= 40 && mass <= 120))
        return fail('AER_PARAM_INVALID', 'bassett_1999 needs riderHeightM 1.4..2.2 m and riderMassKg 40..120 kg', ['riderHeightM']);
      const factors = {
        kd: params.altitudeM === undefined ? 1 : bassettDensityRatio(params.altitudeM),
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
        model,
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
            defaulted: params.k1 === undefined && params.altitudeM === undefined && params.positionFactor === undefined,
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
        `cycling_power bassett_1999: ${data.speedKmh} km/h <-> ${data.powerW} W (K1 ${data.inputs.k1.value}, A_f ${data.inputs.frontalAreaM2} m²).`,
        data,
      );
    }
    if (params.massKg === undefined || !(params.massKg > 0 && params.massKg < 400))
      return fail('AER_PARAM_INVALID', 'martin_1998 needs massKg (rider + bike) in (0, 400)', ['massKg']);
    const areaSources = [params.cdA !== undefined, params.entityIds !== undefined].filter(Boolean).length;
    if (areaSources !== 1 || (params.entityIds !== undefined && params.cd === undefined))
      return fail('AER_AREA_SOURCE_CONFLICT', 'give cdA, or cd + entityIds', ['cdA']);
    let cdA = params.cdA as number;
    let frontal: number | undefined;
    if (params.entityIds !== undefined) {
      const direction = params.flowDirection ?? DEFAULT_FLOW_DIRECTION;
      if (!(Math.hypot(...direction) > 0) || !(params.cd !== undefined && params.cd > 0))
        return fail('AER_PARAM_INVALID', 'cd must be > 0 and flowDirection non-zero', ['cd']);
      const measured = geometryArea(doc, params.entityIds, [direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0], DEFAULT_RESOLUTION);
      if (!measured.ok) return fail(measured.code, measured.message, ['entityIds'], [...measured.ids]);
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
      model,
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
  },
});
