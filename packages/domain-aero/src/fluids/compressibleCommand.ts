/** compressible_flow: one-dimensional gas-dynamics relations (isentropic, shocks, Prandtl-Meyer, Fanno, Rayleigh), NACA Report 1135. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { roundSignificant } from '@lib/significant';
import { briefReport } from '../aerodynamics/brief';
import { refuseFluid } from './codes';
import {
  isentropicState,
  machFromAreaRatio,
  machFromPrandtlMeyer,
  machFromPressureRatio,
  machFromTemperatureRatio,
  MAX_MACH,
  maxPrandtlMeyer,
} from './isentropic';
import { normalShock, obliqueShockFromDeflection, obliqueShockFromWaveAngle } from './shocks';
import { fannoState, rayleighState } from './ductFlow';

const RAD = Math.PI / 180;
const sig = (value: number): number => roundSignificant(value, 10);
const rounded = <T extends object>(record: T): T =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, typeof value === 'number' ? sig(value) : value])) as T;

/**
 * @affects none; data = { relation, gamma, inputs, result (ratios), provenance }
 * @invariant calorically perfect gas, γ constant; ratios dimensionless; angles in degrees
 * @failure γ outside (1, 2), Mach out of range, missing / conflicting inputs -> FLD_*; detached oblique shock -> FLD_SHOCK_DETACHED
 */
export const compressibleFlow = defineCommand({
  name: 'compressible_flow',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only compressible-flow relations of a perfect gas (NACA Report 1135, "Equations, tables, and charts for compressible flow"). ' +
    '`relation`: isentropic (T/T0, p/p0, ρ/ρ0, A/A*, Prandtl-Meyer ν, Mach angle; input `mach`, or `areaRatio` + `branch` subsonic / ' +
    'supersonic, or `pressureRatio` p/p0, or `temperatureRatio` T/T0, or `prandtlMeyerDeg`), normal_shock (`mach` > 1: M2, p2/p1, ρ2/ρ1, ' +
    'T2/T1, p02/p01, p02/p1), oblique_shock (`mach` > 1 and `deflectionDeg` with `branch` weak / strong, or `waveAngleDeg`), fanno ' +
    '(adiabatic duct with friction: 4fL*/D and ratios to the choked state), rayleigh (frictionless duct with heat addition: T0/T0* and ' +
    'ratios). `gamma` = ratio of specific heats (default 1.4 air; ~1.2 rocket exhaust). Used for nozzles, inlets, wind tunnels, pitot ' +
    'corrections; see nozzle_performance for a rocket engine.',
  params: z.object({
    relation: z.enum(['isentropic', 'normal_shock', 'oblique_shock', 'fanno', 'rayleigh']).describe('Which relation to evaluate.'),
    gamma: z.number().optional().describe('Ratio of specific heats γ in (1, 2). Default 1.4 (air).'),
    mach: z.number().optional().describe('Mach number (upstream Mach for shocks), 0 < M <= 100.'),
    areaRatio: z.number().optional().describe('isentropic: A/A* >= 1 (needs branch).'),
    pressureRatio: z.number().optional().describe('isentropic: p/p0 in (0, 1].'),
    temperatureRatio: z.number().optional().describe('isentropic: T/T0 in (0, 1].'),
    prandtlMeyerDeg: z.number().optional().describe('isentropic: Prandtl-Meyer angle ν in degrees (0 .. ν_max, 130.45° at γ 1.4).'),
    deflectionDeg: z.number().optional().describe('oblique_shock: flow deflection (wedge half-angle) θ in degrees, > 0.'),
    waveAngleDeg: z.number().optional().describe('oblique_shock: shock wave angle β in degrees (Mach angle .. 90).'),
    branch: z
      .enum(['subsonic', 'supersonic', 'weak', 'strong'])
      .optional()
      .describe('areaRatio: subsonic / supersonic (default supersonic); oblique shock: weak (default) / strong.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, path = 'mach'): CommandResult =>
      refuseFluid(doc, 'compressible_flow', code, message, [], [path]);
    const gamma = params.gamma ?? 1.4;
    if (!(gamma > 1 && gamma < 2)) return fail('FLD_PARAM_INVALID', 'gamma must be within (1, 2)', 'gamma');
    const provenance = { source: 'NACA Report 1135 (Ames Research Staff 1953), calorically perfect gas', gamma };
    const answer = (inputs: Record<string, unknown>, result: object, summary: string): CommandResult =>
      briefReport(doc, `compressible_flow ${params.relation} (γ ${gamma}): ${summary}`, {
        relation: params.relation,
        gamma,
        inputs,
        result: rounded(result),
        provenance,
      });
    const machOk = (mach: number | undefined, min: number): mach is number => mach !== undefined && mach > min && mach <= MAX_MACH;
    switch (params.relation) {
      case 'isentropic': {
        const given = (['mach', 'areaRatio', 'pressureRatio', 'temperatureRatio', 'prandtlMeyerDeg'] as const).filter(
          (key) => params[key] !== undefined,
        );
        if (given.length !== 1)
          return fail(
            'FLD_INPUT_CONFLICT',
            'isentropic needs exactly one of mach, areaRatio, pressureRatio, temperatureRatio, prandtlMeyerDeg',
          );
        let mach: number;
        if (params.mach !== undefined) mach = params.mach;
        else if (params.areaRatio !== undefined) {
          if (!(params.areaRatio >= 1)) return fail('FLD_PARAM_INVALID', 'areaRatio must be >= 1', 'areaRatio');
          mach = machFromAreaRatio(params.areaRatio, gamma, params.branch === 'subsonic' ? 'subsonic' : 'supersonic');
        } else if (params.pressureRatio !== undefined) {
          if (!(params.pressureRatio > 0 && params.pressureRatio <= 1))
            return fail('FLD_PARAM_INVALID', 'pressureRatio must be in (0, 1]', 'pressureRatio');
          mach = machFromPressureRatio(params.pressureRatio, gamma);
        } else if (params.temperatureRatio !== undefined) {
          if (!(params.temperatureRatio > 0 && params.temperatureRatio <= 1))
            return fail('FLD_PARAM_INVALID', 'temperatureRatio must be in (0, 1]', 'temperatureRatio');
          mach = machFromTemperatureRatio(params.temperatureRatio, gamma);
        } else {
          const nu = (params.prandtlMeyerDeg as number) * RAD;
          if (!(nu >= 0 && nu < maxPrandtlMeyer(gamma)))
            return fail('FLD_PARAM_INVALID', `prandtlMeyerDeg must be within 0..${sig(maxPrandtlMeyer(gamma) / RAD)}`, 'prandtlMeyerDeg');
          mach = machFromPrandtlMeyer(nu, gamma);
        }
        if (!machOk(mach, 0)) return fail('FLD_MACH_RANGE', `Mach ${mach} outside (0, ${MAX_MACH}]`);
        const state = isentropicState(mach, gamma);
        return answer(
          { [given[0] as string]: params[given[0] as 'mach'], ...(params.branch ? { branch: params.branch } : {}) },
          state,
          `M ${sig(mach)}: T/T0 ${sig(state.temperatureRatio)}, p/p0 ${sig(state.pressureRatio)}, ρ/ρ0 ${sig(state.densityRatio)}, A/A* ${sig(state.areaRatio)}, ν ${sig(state.prandtlMeyerDeg)}°.`,
        );
      }
      case 'normal_shock': {
        if (!machOk(params.mach, 1)) return fail('FLD_MACH_RANGE', 'normal_shock needs mach > 1 (upstream)');
        const shock = normalShock(params.mach, gamma);
        return answer(
          { mach: params.mach },
          shock,
          `M1 ${params.mach} -> M2 ${sig(shock.mach2)}, p2/p1 ${sig(shock.pressureRatio)}, ρ2/ρ1 ${sig(shock.densityRatio)}, T2/T1 ${sig(shock.temperatureRatio)}, p02/p01 ${sig(shock.totalPressureRatio)}.`,
        );
      }
      case 'oblique_shock': {
        if (!machOk(params.mach, 1)) return fail('FLD_MACH_RANGE', 'oblique_shock needs mach > 1 (upstream)');
        if ((params.deflectionDeg === undefined) === (params.waveAngleDeg === undefined))
          return fail('FLD_INPUT_CONFLICT', 'oblique_shock needs exactly one of deflectionDeg or waveAngleDeg', 'deflectionDeg');
        const mach = params.mach;
        let shock;
        if (params.waveAngleDeg !== undefined) {
          const machAngle = Math.asin(1 / mach) / RAD;
          if (!(params.waveAngleDeg >= machAngle && params.waveAngleDeg <= 90))
            return fail('FLD_PARAM_INVALID', `waveAngleDeg must be within ${sig(machAngle)}..90`, 'waveAngleDeg');
          shock = obliqueShockFromWaveAngle(mach, params.waveAngleDeg * RAD, gamma);
        } else {
          const theta = params.deflectionDeg as number;
          if (!(theta > 0 && theta < 90)) return fail('FLD_PARAM_INVALID', 'deflectionDeg must be within (0, 90)', 'deflectionDeg');
          const solved = obliqueShockFromDeflection(mach, theta * RAD, gamma, params.branch === 'strong' ? 'strong' : 'weak');
          if (solved === null)
            return fail('FLD_SHOCK_DETACHED', `θ ${theta}° exceeds the maximum deflection at M ${mach}`, 'deflectionDeg');
          shock = solved;
        }
        return answer(
          { mach, deflectionDeg: params.deflectionDeg, waveAngleDeg: params.waveAngleDeg, branch: params.branch ?? 'weak' },
          shock,
          `M1 ${mach}, θ ${sig(shock.deflectionDeg)}°: β ${sig(shock.waveAngleDeg)}°, M2 ${sig(shock.mach2)}, p2/p1 ${sig(shock.pressureRatio)}, p02/p01 ${sig(shock.totalPressureRatio)} (θmax ${sig(shock.maxDeflectionDeg)}°).`,
        );
      }
      case 'fanno':
      case 'rayleigh': {
        if (!machOk(params.mach, 0)) return fail('FLD_MACH_RANGE', `${params.relation} needs mach in (0, ${MAX_MACH}]`);
        const state = params.relation === 'fanno' ? fannoState(params.mach, gamma) : rayleighState(params.mach, gamma);
        const lead = 'frictionParameter' in state ? `4fL*/D ${sig(state.frictionParameter)}` : `T0/T0* ${sig(state.totalTemperatureRatio)}`;
        return answer(
          { mach: params.mach },
          state,
          `M ${params.mach}: ${lead}, p/p* ${sig(state.pressureRatio)}, T/T* ${sig(state.temperatureRatio)}, p0/p0* ${sig(state.totalPressureRatio)}.`,
        );
      }
    }
  },
});
