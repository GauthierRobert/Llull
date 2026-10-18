/**
 * Ideal rocket nozzle (1D, steady, frozen composition, calorically perfect gas, sonic throat; Sutton & Biblarz ch. 3, NASA SP-125 ch. 1):
 * characteristic velocity c*, thrust coefficient C_F, specific impulse, mass flow, exit state, conical divergence factor.
 */

import { isentropicState, machFromAreaRatio, machFromPressureRatio, areaRatio } from './isentropic';

/** Universal gas constant J/(kmol·K) (CODATA 2018 exact: N_A k_B). */
export const UNIVERSAL_GAS_CONSTANT = 8314.462618;
/** Standard gravity m/s² (CGPM 1901, exact), the Isp convention. */
export const STANDARD_GRAVITY = 9.80665;

export interface NozzleInputs {
  readonly chamberPressurePa: number;
  readonly chamberTemperatureK: number;
  readonly gamma: number;
  /** kg/kmol */
  readonly molarMass: number;
  /** A_e / A_t */
  readonly expansionRatio: number;
  readonly throatAreaM2: number;
  readonly ambientPressurePa: number;
  /** Momentum-thrust multiplier: conical (1 + cos α)/2, bell ≈ 0.98-0.99 or 1 (ideal). */
  readonly divergenceFactor: number;
  /** η_c*: delivered / ideal characteristic velocity (1 = ideal); at fixed p_c and A_t it raises ṁ and lowers Isp, F = C_F p_c A_t. */
  readonly cStarEfficiency: number;
}

export interface NozzleResult {
  readonly gasConstant: number;
  readonly cStar: number;
  readonly exitMach: number;
  readonly exitPressurePa: number;
  readonly exitTemperatureK: number;
  readonly exitVelocity: number;
  readonly throatTemperatureK: number;
  readonly throatPressurePa: number;
  readonly massFlowKgS: number;
  /** C_F in vacuum (pa = 0) */
  readonly thrustCoefficientVacuum: number;
  /** C_F at the ambient pressure */
  readonly thrustCoefficient: number;
  readonly thrustVacuumN: number;
  readonly thrustN: number;
  readonly ispVacuumS: number;
  readonly ispS: number;
  /** Expansion ratio for which p_e = p_a (optimum at this ambient), or null in vacuum. */
  readonly optimumExpansionRatio: number | null;
  readonly exitAreaM2: number;
}

/** Γ(γ) = √γ (2/(γ+1))^((γ+1)/(2(γ-1))): the Vandenkerckhove function. */
export const vandenkerckhove = (gamma: number): number => Math.sqrt(gamma) * (2 / (gamma + 1)) ** ((gamma + 1) / (2 * (gamma - 1)));

/** c* = √(R T_c) / Γ(γ). */
export const characteristicVelocity = (gasConstant: number, chamberTemperatureK: number, gamma: number): number =>
  Math.sqrt(gasConstant * chamberTemperatureK) / vandenkerckhove(gamma);

/** Momentum part of C_F: Γ √( 2γ/(γ-1) (1 - (p_e/p_c)^((γ-1)/γ)) ). */
export function momentumThrustCoefficient(gamma: number, exitPressureRatio: number): number {
  return vandenkerckhove(gamma) * Math.sqrt(((2 * gamma) / (gamma - 1)) * (1 - exitPressureRatio ** ((gamma - 1) / gamma)));
}

/** Conical-nozzle divergence factor λ = (1 + cos α)/2 for half-angle α (rad) (Malina 1940; Sutton eq. 3-34). */
export const conicalDivergenceFactor = (halfAngle: number): number => (1 + Math.cos(halfAngle)) / 2;

/** A_e/A_t that expands the chamber pressure exactly to `pressure` (supersonic branch). */
export function expansionRatioForPressure(chamberPressurePa: number, pressure: number, gamma: number): number {
  return areaRatio(machFromPressureRatio(pressure / chamberPressurePa, gamma), gamma);
}

/** Exit Mach of an expansion ratio (supersonic branch). */
export const exitMachOf = (expansionRatio: number, gamma: number): number => machFromAreaRatio(expansionRatio, gamma, 'supersonic');

export function idealNozzle(input: NozzleInputs): NozzleResult {
  const { chamberPressurePa: pc, chamberTemperatureK: tc, gamma, expansionRatio, throatAreaM2: at, ambientPressurePa: pa } = input;
  const gasConstant = UNIVERSAL_GAS_CONSTANT / input.molarMass;
  const cStar = characteristicVelocity(gasConstant, tc, gamma) * input.cStarEfficiency;
  const exitMach = exitMachOf(expansionRatio, gamma);
  const exit = isentropicState(exitMach, gamma);
  const throat = isentropicState(1, gamma);
  const pe = pc * exit.pressureRatio;
  const momentum = momentumThrustCoefficient(gamma, exit.pressureRatio) * input.divergenceFactor;
  const cfVacuum = momentum + expansionRatio * exit.pressureRatio;
  const cf = cfVacuum - expansionRatio * (pa / pc);
  const massFlow = (pc * at) / cStar;
  const thrustVacuum = cfVacuum * pc * at;
  const thrust = cf * pc * at;
  return {
    gasConstant,
    cStar,
    exitMach,
    exitPressurePa: pe,
    exitTemperatureK: tc * exit.temperatureRatio,
    exitVelocity: cStar * momentum,
    throatTemperatureK: tc * throat.temperatureRatio,
    throatPressurePa: pc * throat.pressureRatio,
    massFlowKgS: massFlow,
    thrustCoefficientVacuum: cfVacuum,
    thrustCoefficient: cf,
    thrustVacuumN: thrustVacuum,
    thrustN: thrust,
    ispVacuumS: thrustVacuum / (massFlow * STANDARD_GRAVITY),
    ispS: thrust / (massFlow * STANDARD_GRAVITY),
    optimumExpansionRatio: pa > 0 && pa < pc ? expansionRatioForPressure(pc, pa, gamma) : null,
    exitAreaM2: at * expansionRatio,
  };
}
