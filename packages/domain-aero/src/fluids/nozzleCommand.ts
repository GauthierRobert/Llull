/** nozzle_performance: ideal rocket thrust chamber performance (c*, C_F, Isp, thrust, mass flow, exit state) at an ambient pressure. */

import { defineCommand } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { briefReport, sig } from '../shared/results';
import { refuseFluid } from './codes';
import { PRESSURE_UNITS, type PressureUnit } from './pressure';
import {
  characteristicVelocity,
  idealNozzle,
  momentumThrustCoefficient,
  STANDARD_GRAVITY,
  UNIVERSAL_GAS_CONSTANT,
  type NozzleResult,
} from './rocketNozzle';
import { isRefusal, nozzleParams, resolveNozzleSetup, resolveThroatArea, type NozzleRefusal, type NozzleSetup } from './nozzleInputs';
import { expansionState, MODEL_LIMITATION, nozzleWarnings, type ExpansionState } from './nozzleDiagnostics';

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
  params: nozzleParams,
  run: (doc, params): CommandResult => {
    const fail = ({ code, message, path }: NozzleRefusal): CommandResult =>
      refuseFluid(doc, 'nozzle_performance', code, message, [], [path]);
    const setup = resolveNozzleSetup(params);
    if (isRefusal(setup)) return fail(setup);
    const unitArea = idealNozzle({ ...setup.nozzle, throatAreaM2: 1 });
    const pc = setup.nozzle.chamberPressurePa;
    const throatArea = resolveThroatArea(params, { vacuum: unitArea.thrustCoefficientVacuum, ambient: unitArea.thrustCoefficient }, pc);
    if (isRefusal(throatArea)) return fail(throatArea);
    const result = idealNozzle({ ...setup.nozzle, throatAreaM2: throatArea ?? 1 });
    const data = nozzleData(params, setup, result, throatArea);
    const caseWarnings = nozzleWarnings(result, setup.nozzle.ambientPressurePa, setup.ambientDefaulted);
    return briefReport(
      doc,
      `nozzle_performance p_c ${params.chamberPressure} ${params.pressureUnit}, T_c ${params.chamberTemperatureK} K, γ ${params.gamma}, M ${params.molarMass}, ε ${data.inputs.expansionRatio}: c* ${data.cStarMS} m/s, ` +
        `M_e ${data.exit.mach}, p_e ${data.exit.pressure} ${params.pressureUnit}; C_F vac ${data.thrustCoefficient.vacuum} / amb ${data.thrustCoefficient.ambient}; ` +
        `Isp vac ${data.ispS.vacuum} s / amb ${data.ispS.ambient} s (${setup.ambientSource})` +
        (data.sizing === undefined
          ? ''
          : `; D_t ${data.sizing.throatDiameterM} m, ṁ ${data.sizing.massFlowKgS} kg/s, F vac ${data.sizing.thrustVacuumN} N / amb ${data.sizing.thrustN} N`) +
        (caseWarnings.length > 0 ? `. Warning: ${caseWarnings[0]}` : '.'),
      data,
    );
  },
});

/** `data` of nozzle_performance (SI: Pa, K, m/s, s, m, kg/s, N; `exit.pressure` in the request's pressureUnit). */
interface NozzleData {
  readonly inputs: {
    readonly chamberPressurePa: number;
    readonly chamberTemperatureK: number;
    readonly gamma: number;
    readonly molarMass: number;
    readonly gasConstantJKgK: number;
    readonly expansionRatio: number;
    readonly divergence: { readonly kind: NozzleSetup['divergence']; readonly factor: number; readonly defaulted: boolean };
    readonly cStarEfficiency: { readonly value: number; readonly defaulted: boolean };
    readonly ambient: { readonly pressurePa: number; readonly source: string; readonly defaulted: boolean };
  };
  readonly cStarMS: number;
  readonly idealCStarMS: number;
  readonly throat: { readonly temperatureK: number; readonly pressurePa: number };
  readonly exit: {
    readonly mach: number;
    readonly pressurePa: number;
    readonly pressure: number;
    readonly temperatureK: number;
    readonly velocityMS: number;
    readonly idealVelocityMS: number;
  };
  readonly thrustCoefficient: { readonly vacuum: number; readonly ambient: number };
  readonly ispS: { readonly vacuum: number; readonly ambient: number | null };
  readonly effectiveExhaustVelocityMS: { readonly vacuum: number; readonly ambient: number };
  readonly optimumExpansionRatio: number | null;
  readonly expansionState: ExpansionState;
  readonly sizing?: {
    readonly throatAreaM2: number;
    readonly throatDiameterM: number;
    readonly exitDiameterM: number;
    readonly massFlowKgS: number;
    readonly thrustVacuumN: number;
    readonly thrustN: number;
  };
  readonly warnings: readonly string[];
  readonly provenance: { readonly formulas: Readonly<Record<string, string>>; readonly sources: readonly string[] };
}

/** The command's `data`: inputs with their sources, performance, optional sizing, warnings and provenance. */
function nozzleData(
  params: { readonly pressureUnit: PressureUnit },
  setup: NozzleSetup,
  result: NozzleResult,
  throatArea: number | undefined,
): NozzleData {
  const { chamberPressurePa: pc, chamberTemperatureK: tc, gamma, molarMass, expansionRatio, ambientPressurePa: pa } = setup.nozzle;
  return {
    inputs: {
      chamberPressurePa: sig(pc),
      chamberTemperatureK: tc,
      gamma,
      molarMass,
      gasConstantJKgK: sig(result.gasConstant),
      expansionRatio: sig(expansionRatio),
      divergence: { kind: setup.divergence, factor: sig(setup.nozzle.divergenceFactor), defaulted: setup.defaulted.divergence },
      cStarEfficiency: { value: setup.nozzle.cStarEfficiency, defaulted: setup.defaulted.cStarEfficiency },
      ambient: { pressurePa: sig(pa), source: setup.ambientSource, defaulted: setup.ambientDefaulted },
    },
    cStarMS: sig(result.cStar),
    idealCStarMS: sig(characteristicVelocity(UNIVERSAL_GAS_CONSTANT / molarMass, tc, gamma)),
    throat: { temperatureK: sig(result.throatTemperatureK), pressurePa: sig(result.throatPressurePa) },
    exit: {
      mach: sig(result.exitMach),
      pressurePa: sig(result.exitPressurePa),
      pressure: sig(result.exitPressurePa / PRESSURE_UNITS[params.pressureUnit]),
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
    expansionState: expansionState(result, pa),
    ...(throatArea === undefined
      ? {}
      : {
          sizing: {
            throatAreaM2: sig(throatArea),
            throatDiameterM: sig(Math.sqrt((4 * throatArea) / Math.PI)),
            exitDiameterM: sig(Math.sqrt((4 * throatArea * expansionRatio) / Math.PI)),
            massFlowKgS: sig(result.massFlowKgS),
            thrustVacuumN: sig(result.thrustVacuumN),
            thrustN: sig(result.thrustN),
          },
        }),
    warnings: [...nozzleWarnings(result, pa, setup.ambientDefaulted), MODEL_LIMITATION],
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
}
