/** nozzle_performance: ideal rocket thrust chamber performance (c*, C_F, Isp, thrust, mass flow, exit state) at an ambient pressure. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { briefReport, sig } from '../shared/results';
import { refuseFluid } from './codes';
import { pressureUnitParam, toPascal, PRESSURE_UNITS } from './pressure';
import { conicalDivergenceFactor, expansionRatioForPressure, idealNozzle, STANDARD_GRAVITY, UNIVERSAL_GAS_CONSTANT } from './rocketNozzle';
import { characteristicVelocity, momentumThrustCoefficient } from './rocketNozzle';
import { isentropicState } from './isentropic';
import { resolveAirState, isAirState } from '../shared/airState';

const RAD = Math.PI / 180;
/** Summerfield criterion: flow separates when the exit pressure falls below ≈ 0.4 of ambient (Summerfield, Foster & Swan 1954). */
export const SUMMERFIELD_RATIO = 0.4;

/**
 * @affects none; data = { inputs (with defaulted flags), cStarMS, exit { mach, pressurePa, temperatureK, velocityMS }, throat, thrustCoefficient { vacuum, ambient }, ispS { vacuum, ambient }, sizing?, expansionState, warnings, provenance }
 * @invariant 1D isentropic, γ and molar mass constant from the chamber to the exit; F = C_F p_c A_t; Isp = c* C_F / g0
 * @failure missing / conflicting inputs -> FLD_INPUT_CONFLICT; non-physical values -> FLD_PARAM_INVALID; ε <= 1 or p_e >= p_c -> FLD_EXPANSION_INVALID
 */
export const nozzlePerformance = defineCommand({
  name: 'nozzle_performance',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only ideal rocket engine (thrust chamber + nozzle) performance by 1D isentropic flow of a perfect gas (Sutton & Biblarz ch. 3, ' +
    'NASA SP-125): characteristic velocity c*, exit Mach / pressure / temperature / velocity, thrust coefficient C_F and specific impulse ' +
    'Isp in vacuum and at the ambient pressure, mass flow and thrust. Chamber: `chamberPressure` (+ required `pressureUnit`), ' +
    '`chamberTemperatureK`, `gamma` and `molarMass` (kg/kmol) of the combustion gas — take the chamber values of a NASA CEA run, e.g. ' +
    'LOX/LH2 MR 6 at 206 bar: Tc 3599 K, γ 1.1475, M 13.61 (c* then matches CEA to 0.1 %, Isp the shifting-equilibrium value to ~3 %). Nozzle: `expansionRatio` Ae/At or ' +
    '`exitPressure`; `divergence` ideal (λ 1, default), conical (`halfAngleDeg`, λ = (1+cos α)/2) or factor (`divergenceFactor`, e.g. ' +
    '0.99 for an 80 % bell). Ambient: `ambientPressure` or `altitudeM` (standard atmosphere); default vacuum. Size by `throatDiameterM`, ' +
    '`throatAreaM2` or a `thrustN` target (in vacuum or at ambient, `thrustAt`). `cStarEfficiency` (default 1) models combustion losses. ' +
    'Warns on over-expansion and on likely flow separation (p_e < 0.4 p_a, Summerfield). Next: design_nozzle for the CAD contour.',
  params: z.object({
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
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseFluid(doc, 'nozzle_performance', code, message, [], [path]);
    const unit = params.pressureUnit;
    const pc = toPascal(params.chamberPressure, unit);
    const { chamberTemperatureK: tc, gamma, molarMass } = params;
    if (!(pc > 0) || !(tc > 0 && tc < 10000) || !(gamma > 1 && gamma < 2) || !(molarMass > 0 && molarMass < 500))
      return fail(
        'FLD_PARAM_INVALID',
        'chamberPressure > 0, chamberTemperatureK in (0, 10000), gamma in (1, 2), molarMass in (0, 500)',
        'chamberPressure',
      );
    if ((params.expansionRatio === undefined) === (params.exitPressure === undefined))
      return fail('FLD_INPUT_CONFLICT', 'give exactly one of expansionRatio or exitPressure', 'expansionRatio');
    let epsilon = params.expansionRatio as number;
    if (params.exitPressure !== undefined) {
      const pe = toPascal(params.exitPressure, unit);
      if (!(pe > 0 && pe < pc * isentropicState(1, gamma).pressureRatio))
        return fail('FLD_EXPANSION_INVALID', 'exitPressure must be > 0 and below the throat pressure', 'exitPressure');
      epsilon = expansionRatioForPressure(pc, pe, gamma);
    }
    if (!(epsilon > 1 && epsilon < 1e5))
      return fail('FLD_EXPANSION_INVALID', `expansion ratio ${epsilon} must be within (1, 1e5)`, 'expansionRatio');
    const divergence = params.divergence ?? 'ideal';
    let lambda = 1;
    if (divergence === 'conical') {
      if (params.halfAngleDeg === undefined || !(params.halfAngleDeg > 0 && params.halfAngleDeg < 45))
        return fail('FLD_PARAM_INVALID', 'conical needs halfAngleDeg in (0, 45)', 'halfAngleDeg');
      lambda = conicalDivergenceFactor(params.halfAngleDeg * RAD);
    } else if (divergence === 'factor') {
      if (params.divergenceFactor === undefined || !(params.divergenceFactor > 0.8 && params.divergenceFactor <= 1))
        return fail('FLD_PARAM_INVALID', 'factor needs divergenceFactor in (0.8, 1]', 'divergenceFactor');
      lambda = params.divergenceFactor;
    }
    const eta = params.cStarEfficiency ?? 1;
    if (!(eta > 0.8 && eta <= 1)) return fail('FLD_PARAM_INVALID', 'cStarEfficiency must be within (0.8, 1]', 'cStarEfficiency');
    if (params.ambientPressure !== undefined && params.altitudeM !== undefined)
      return fail('FLD_INPUT_CONFLICT', 'give ambientPressure or altitudeM, not both', 'ambientPressure');
    let pa = 0;
    let ambientSource = 'vacuum (default)';
    if (params.ambientPressure !== undefined) {
      pa = toPascal(params.ambientPressure, unit);
      ambientSource = 'given';
      if (!(pa >= 0)) return fail('FLD_PARAM_INVALID', 'ambientPressure must be >= 0', 'ambientPressure');
    } else if (params.altitudeM !== undefined) {
      const air = resolveAirState({ altitudeM: params.altitudeM });
      if (!isAirState(air) || air.pressurePa === null)
        return fail('FLD_PARAM_INVALID', 'altitudeM must be within -5000..86000 m', 'altitudeM');
      pa = air.pressurePa;
      ambientSource = air.source;
    }
    if (pa >= pc) return fail('FLD_EXPANSION_INVALID', 'the ambient pressure must be below the chamber pressure', 'ambientPressure');
    const sizing = [params.throatDiameterM, params.throatAreaM2, params.thrustN].filter((value) => value !== undefined);
    if (sizing.length > 1)
      return fail('FLD_INPUT_CONFLICT', 'give at most one of throatDiameterM, throatAreaM2, thrustN', 'throatDiameterM');
    if (sizing.some((value) => !((value as number) > 0))) return fail('FLD_PARAM_INVALID', 'sizing inputs must be > 0', 'throatDiameterM');
    const base = {
      chamberPressurePa: pc,
      chamberTemperatureK: tc,
      gamma,
      molarMass,
      expansionRatio: epsilon,
      ambientPressurePa: pa,
      divergenceFactor: lambda,
      cStarEfficiency: eta,
    };
    const unitArea = idealNozzle({ ...base, throatAreaM2: 1 });
    let throatArea: number | undefined =
      params.throatAreaM2 ?? (params.throatDiameterM === undefined ? undefined : (Math.PI / 4) * params.throatDiameterM ** 2);
    if (params.thrustN !== undefined) {
      const cf = params.thrustAt === 'ambient' ? unitArea.thrustCoefficient : unitArea.thrustCoefficientVacuum;
      if (!(cf > 0)) return fail('FLD_PARAM_INVALID', 'the nozzle gives no positive thrust at this ambient pressure', 'thrustN');
      throatArea = params.thrustN / (cf * pc);
    }
    const result = idealNozzle({ ...base, throatAreaM2: throatArea ?? 1 });
    const pressureRatio = result.exitPressurePa / Math.max(pa, Number.MIN_VALUE);
    const warnings: string[] = [];
    if (pa > 0 && result.exitPressurePa < SUMMERFIELD_RATIO * pa)
      warnings.push(
        `p_e/p_a = ${sig(pressureRatio)} < 0.4: the flow likely separates inside the nozzle (Summerfield); the ambient values assume attached flow.`,
      );
    else if (pa > 0 && result.exitPressurePa < pa)
      warnings.push(`over-expanded (p_e/p_a ${sig(pressureRatio)}): thrust is below the optimum at this ambient.`);
    if (params.ambientPressure === undefined && params.altitudeM === undefined) warnings.push('ambient defaulted to vacuum (p_a = 0).');
    if (!(result.thrustCoefficient > 0))
      warnings.push(`no net thrust at this ambient pressure (C_F ${sig(result.thrustCoefficient)}): ambient Isp is null.`);
    warnings.push(
      'Ideal 1D flow with one constant γ: with the CEA chamber γ the Isp is within ~3 % of shifting equilibrium, a frozen-composition expansion gives 4-6 % less; real engines deliver less still (RS-25: 452.3 s vs ~473 s ideal).',
    );
    const toUnit = (pa2: number): number => sig(pa2 / PRESSURE_UNITS[unit]);
    const data = {
      inputs: {
        chamberPressurePa: sig(pc),
        chamberTemperatureK: tc,
        gamma,
        molarMass,
        gasConstantJKgK: sig(result.gasConstant),
        expansionRatio: sig(epsilon),
        divergence: { kind: divergence, factor: sig(lambda), defaulted: params.divergence === undefined },
        cStarEfficiency: { value: eta, defaulted: params.cStarEfficiency === undefined },
        ambient: {
          pressurePa: sig(pa),
          source: ambientSource,
          defaulted: params.ambientPressure === undefined && params.altitudeM === undefined,
        },
      },
      cStarMS: sig(result.cStar),
      idealCStarMS: sig(characteristicVelocity(UNIVERSAL_GAS_CONSTANT / molarMass, tc, gamma)),
      throat: { temperatureK: sig(result.throatTemperatureK), pressurePa: sig(result.throatPressurePa) },
      exit: {
        mach: sig(result.exitMach),
        pressurePa: sig(result.exitPressurePa),
        pressure: toUnit(result.exitPressurePa),
        temperatureK: sig(result.exitTemperatureK),
        velocityMS: sig(result.exitVelocity),
        idealVelocityMS: sig(
          characteristicVelocity(result.gasConstant, tc, gamma) * momentumThrustCoefficient(gamma, result.exitPressurePa / pc),
        ),
      },
      thrustCoefficient: { vacuum: sig(result.thrustCoefficientVacuum), ambient: sig(result.thrustCoefficient) },
      ispS: { vacuum: sig(result.ispVacuumS), ambient: result.thrustCoefficient > 0 ? sig(result.ispS) : null },
      effectiveExhaustVelocityMS: { vacuum: sig(result.ispVacuumS * STANDARD_GRAVITY), ambient: sig(result.ispS * STANDARD_GRAVITY) },
      optimumExpansionRatio: result.optimumExpansionRatio === null ? null : sig(result.optimumExpansionRatio),
      expansionState:
        pa === 0 ? 'vacuum' : Math.abs(pressureRatio - 1) < 0.02 ? 'optimum' : pressureRatio > 1 ? 'under-expanded' : 'over-expanded',
      ...(throatArea === undefined
        ? {}
        : {
            sizing: {
              throatAreaM2: sig(throatArea),
              throatDiameterM: sig(Math.sqrt((4 * throatArea) / Math.PI)),
              exitDiameterM: sig(Math.sqrt((4 * throatArea * epsilon) / Math.PI)),
              massFlowKgS: sig(result.massFlowKgS),
              thrustVacuumN: sig(result.thrustVacuumN),
              thrustN: sig(result.thrustN),
            },
          }),
      warnings,
      provenance: {
        formulas: {
          cStar: 'c* = η √(R T_c) / Γ, Γ = √γ (2/(γ+1))^((γ+1)/(2(γ-1)))',
          thrustCoefficient: 'C_F = λ Γ √(2γ/(γ-1) (1 - (p_e/p_c)^((γ-1)/γ))) + ε (p_e - p_a)/p_c',
          isp: 'Isp = c* C_F / g0, g0 = 9.80665 m/s²; F = C_F p_c A_t; ṁ = p_c A_t / c*',
          separation: 'Summerfield: separation when p_e < ~0.4 p_a',
        },
        sources: ['Sutton & Biblarz, Rocket Propulsion Elements, ch. 3', 'Huzel & Huang, NASA SP-125 (1967) ch. 1', 'NACA Report 1135'],
      },
    };
    return briefReport(
      doc,
      `nozzle_performance p_c ${params.chamberPressure} ${unit}, T_c ${tc} K, γ ${gamma}, M ${molarMass}, ε ${data.inputs.expansionRatio}: c* ${data.cStarMS} m/s, ` +
        `M_e ${data.exit.mach}, p_e ${data.exit.pressure} ${unit}; C_F vac ${data.thrustCoefficient.vacuum} / amb ${data.thrustCoefficient.ambient}; ` +
        `Isp vac ${data.ispS.vacuum} s / amb ${data.ispS.ambient} s (${ambientSource})` +
        (data.sizing === undefined
          ? ''
          : `; D_t ${data.sizing.throatDiameterM} m, ṁ ${data.sizing.massFlowKgS} kg/s, F vac ${data.sizing.thrustVacuumN} N / amb ${data.sizing.thrustN} N`) +
        (warnings.length > 1 ? `. Warning: ${warnings[0]}` : '.'),
      data,
    );
  },
});
