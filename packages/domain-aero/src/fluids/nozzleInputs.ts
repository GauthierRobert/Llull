/** nozzle_performance params and their resolution into SI inputs of the ideal nozzle (or the first refusal). */

import { z } from '@core/commands/schema';
import { isAirState, resolveAirState } from '../shared/airState';
import { pressureUnitParam, toPascal } from './pressure';
import { conicalDivergenceFactor, expansionRatioForPressure, type NozzleInputs } from './rocketNozzle';
import { isentropicState } from './isentropic';

const RAD = Math.PI / 180;

export const nozzleParams = z.object({
  chamberPressure: z.number().describe('Chamber (stagnation) pressure in pressureUnit, > 0.'),
  pressureUnit: pressureUnitParam,
  chamberTemperatureK: z.number().describe('Chamber (combustion) temperature in K, > 0.'),
  gamma: z.number().describe('Ratio of specific heats of the gas, 1 < γ < 2 (≈ 1.13-1.25 for combustion products).'),
  molarMass: z.number().describe('Molar mass of the gas in kg/kmol (g/mol), > 0.'),
  expansionRatio: z.number().optional().describe('Nozzle area ratio Ae/At > 1. Give this or exitPressure.'),
  exitPressure: z.number().optional().describe('Design exit pressure in pressureUnit (0 < p_e < p_c). Give this or expansionRatio.'),
  divergence: z
    .enum(['ideal', 'conical', 'factor'])
    .optional()
    .describe('Exit-flow divergence loss: ideal (default, λ 1), conical (halfAngleDeg) or factor.'),
  halfAngleDeg: z.number().optional().describe('conical: nozzle half-angle in degrees, 0 < α < 45 (15 typical).'),
  divergenceFactor: z.number().optional().describe('factor: momentum-thrust multiplier λ in (0.8, 1].'),
  cStarEfficiency: z.number().optional().describe('Delivered / ideal c*, (0.8, 1]. Default 1.'),
  ambientPressure: z.number().optional().describe('Ambient pressure in pressureUnit, >= 0 (0 = vacuum). Or altitudeM.'),
  altitudeM: z
    .number()
    .optional()
    .describe('Ambient pressure of the U.S. Standard Atmosphere 1976 at this geometric altitude in m (-5000..86000).'),
  throatDiameterM: z.number().optional().describe('Throat diameter in m, > 0 (sizing; give at most one of the three sizing inputs).'),
  throatAreaM2: z.number().optional().describe('Throat area in m², > 0.'),
  thrustN: z.number().optional().describe('Target thrust in N, > 0: the throat is sized for it.'),
  thrustAt: z.enum(['vacuum', 'ambient']).optional().describe('Condition of thrustN: vacuum (default) or ambient.'),
});

type NozzleParams = z.infer<typeof nozzleParams>;

/** Resolved inputs: the ideal-nozzle inputs without the throat area, plus what the result must report about where they came from. */
export interface NozzleSetup {
  readonly nozzle: Omit<NozzleInputs, 'throatAreaM2'>;
  readonly divergence: 'ideal' | 'conical' | 'factor';
  readonly ambientSource: string;
  readonly ambientDefaulted: boolean;
  /** Inputs left to their defaults (divergence ideal, c* efficiency 1). */
  readonly defaulted: { readonly divergence: boolean; readonly cStarEfficiency: boolean };
}

export interface NozzleRefusal {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

const refusal = (code: string, message: string, path: string): NozzleRefusal => ({ code, message, path });

/** ε from `expansionRatio` or from the design `exitPressure`. */
function expansionRatioOf(params: NozzleParams, pc: number): number | NozzleRefusal {
  if ((params.expansionRatio === undefined) === (params.exitPressure === undefined))
    return refusal('FLD_INPUT_CONFLICT', 'give exactly one of expansionRatio or exitPressure', 'expansionRatio');
  let epsilon = params.expansionRatio as number;
  if (params.exitPressure !== undefined) {
    const pe = toPascal(params.exitPressure, params.pressureUnit);
    if (!(pe > 0 && pe < pc * isentropicState(1, params.gamma).pressureRatio))
      return refusal('FLD_EXPANSION_INVALID', 'exitPressure must be > 0 and below the throat pressure', 'exitPressure');
    epsilon = expansionRatioForPressure(pc, pe, params.gamma);
  }
  return epsilon > 1 && epsilon < 1e5
    ? epsilon
    : refusal('FLD_EXPANSION_INVALID', `expansion ratio ${epsilon} must be within (1, 1e5)`, 'expansionRatio');
}

/** Momentum-thrust multiplier λ of the divergence option. */
function divergenceFactorOf(params: NozzleParams): number | NozzleRefusal {
  switch (params.divergence ?? 'ideal') {
    case 'ideal':
      return 1;
    case 'conical':
      return params.halfAngleDeg !== undefined && params.halfAngleDeg > 0 && params.halfAngleDeg < 45
        ? conicalDivergenceFactor(params.halfAngleDeg * RAD)
        : refusal('FLD_PARAM_INVALID', 'conical needs halfAngleDeg in (0, 45)', 'halfAngleDeg');
    case 'factor':
      return params.divergenceFactor !== undefined && params.divergenceFactor > 0.8 && params.divergenceFactor <= 1
        ? params.divergenceFactor
        : refusal('FLD_PARAM_INVALID', 'factor needs divergenceFactor in (0.8, 1]', 'divergenceFactor');
  }
}

/** Ambient pressure in Pa from `ambientPressure` or `altitudeM` (vacuum when neither is given). */
function ambientOf(params: NozzleParams): { pressurePa: number; source: string } | NozzleRefusal {
  if (params.ambientPressure !== undefined && params.altitudeM !== undefined)
    return refusal('FLD_INPUT_CONFLICT', 'give ambientPressure or altitudeM, not both', 'ambientPressure');
  if (params.ambientPressure !== undefined) {
    const pressurePa = toPascal(params.ambientPressure, params.pressureUnit);
    return pressurePa >= 0
      ? { pressurePa, source: 'given' }
      : refusal('FLD_PARAM_INVALID', 'ambientPressure must be >= 0', 'ambientPressure');
  }
  if (params.altitudeM === undefined) return { pressurePa: 0, source: 'vacuum (default)' };
  const air = resolveAirState({ altitudeM: params.altitudeM });
  return isAirState(air) && air.pressurePa !== null
    ? { pressurePa: air.pressurePa, source: air.source }
    : refusal('FLD_PARAM_INVALID', 'altitudeM must be within -5000..86000 m', 'altitudeM');
}

export const isRefusal = (value: unknown): value is NozzleRefusal => typeof value === 'object' && value !== null && 'code' in value;

/**
 * Validate and convert every input except the sizing.
 * @failure the first invalid input -> NozzleRefusal (code, message, param path)
 */
export function resolveNozzleSetup(params: NozzleParams): NozzleSetup | NozzleRefusal {
  const pc = toPascal(params.chamberPressure, params.pressureUnit);
  const { chamberTemperatureK, gamma, molarMass } = params;
  if (
    !(pc > 0) ||
    !(chamberTemperatureK > 0 && chamberTemperatureK < 10000) ||
    !(gamma > 1 && gamma < 2) ||
    !(molarMass > 0 && molarMass < 500)
  )
    return refusal(
      'FLD_PARAM_INVALID',
      'chamberPressure > 0, chamberTemperatureK in (0, 10000), gamma in (1, 2), molarMass in (0, 500)',
      'chamberPressure',
    );
  const expansionRatio = expansionRatioOf(params, pc);
  if (isRefusal(expansionRatio)) return expansionRatio;
  const divergenceFactor = divergenceFactorOf(params);
  if (isRefusal(divergenceFactor)) return divergenceFactor;
  const cStarEfficiency = params.cStarEfficiency ?? 1;
  if (!(cStarEfficiency > 0.8 && cStarEfficiency <= 1))
    return refusal('FLD_PARAM_INVALID', 'cStarEfficiency must be within (0.8, 1]', 'cStarEfficiency');
  const ambient = ambientOf(params);
  if (isRefusal(ambient)) return ambient;
  if (ambient.pressurePa >= pc)
    return refusal('FLD_EXPANSION_INVALID', 'the ambient pressure must be below the chamber pressure', 'ambientPressure');
  return {
    nozzle: {
      chamberPressurePa: pc,
      chamberTemperatureK,
      gamma,
      molarMass,
      expansionRatio,
      ambientPressurePa: ambient.pressurePa,
      divergenceFactor,
      cStarEfficiency,
    },
    divergence: params.divergence ?? 'ideal',
    ambientSource: ambient.source,
    ambientDefaulted: params.ambientPressure === undefined && params.altitudeM === undefined,
    defaulted: { divergence: params.divergence === undefined, cStarEfficiency: params.cStarEfficiency === undefined },
  };
}

/**
 * Throat area in m² from `throatAreaM2`, `throatDiameterM` or a `thrustN` target; undefined when none is given (coefficients only).
 * @failure more than one sizing input, a non-positive one, or no positive thrust for the target -> NozzleRefusal
 */
export function resolveThroatArea(
  params: NozzleParams,
  thrustCoefficient: { readonly vacuum: number; readonly ambient: number },
  chamberPressurePa: number,
): number | undefined | NozzleRefusal {
  const sizing = [params.throatDiameterM, params.throatAreaM2, params.thrustN].filter((value) => value !== undefined);
  if (sizing.length > 1)
    return refusal('FLD_INPUT_CONFLICT', 'give at most one of throatDiameterM, throatAreaM2, thrustN', 'throatDiameterM');
  if (sizing.some((value) => !((value as number) > 0))) return refusal('FLD_PARAM_INVALID', 'sizing inputs must be > 0', 'throatDiameterM');
  if (params.throatAreaM2 !== undefined) return params.throatAreaM2;
  if (params.throatDiameterM !== undefined) return (Math.PI / 4) * params.throatDiameterM ** 2;
  if (params.thrustN === undefined) return undefined;
  const cf = params.thrustAt === 'ambient' ? thrustCoefficient.ambient : thrustCoefficient.vacuum;
  return cf > 0
    ? params.thrustN / (cf * chamberPressurePa)
    : refusal('FLD_PARAM_INVALID', 'the nozzle gives no positive thrust at this ambient pressure', 'thrustN');
}
