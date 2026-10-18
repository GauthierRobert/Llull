/** Quasi-1D isentropic flow of a calorically perfect gas (NACA Report 1135 eqs. 43-45, 80): ratios to stagnation / sonic state, inverses. */

import { bisect } from '@lib/bisect';

export interface IsentropicState {
  readonly mach: number;
  /** T / T0 */
  readonly temperatureRatio: number;
  /** p / p0 */
  readonly pressureRatio: number;
  /** ρ / ρ0 */
  readonly densityRatio: number;
  /** A / A* (sonic throat) */
  readonly areaRatio: number;
  /** Prandtl-Meyer angle ν in degrees (supersonic only, else 0). */
  readonly prandtlMeyerDeg: number;
  /** Mach angle μ = asin(1/M) in degrees (supersonic only, else 90). */
  readonly machAngleDeg: number;
}

const DEG = 180 / Math.PI;

/** T0 / T = 1 + (γ-1)/2 M². */
export const stagnationTemperatureFactor = (mach: number, gamma: number): number => 1 + ((gamma - 1) / 2) * mach * mach;

/** A / A* = (1/M) [ (2/(γ+1)) (1 + (γ-1)/2 M²) ]^((γ+1)/(2(γ-1))). */
export function areaRatio(mach: number, gamma: number): number {
  const exponent = (gamma + 1) / (2 * (gamma - 1));
  return ((2 / (gamma + 1)) * stagnationTemperatureFactor(mach, gamma)) ** exponent / mach;
}

/** Prandtl-Meyer function ν(M) in radians, M ≥ 1. */
export function prandtlMeyer(mach: number, gamma: number): number {
  if (mach <= 1) return 0;
  const k = (gamma + 1) / (gamma - 1);
  const m2 = mach * mach - 1;
  return Math.sqrt(k) * Math.atan(Math.sqrt(m2 / k)) - Math.atan(Math.sqrt(m2));
}

export function isentropicState(mach: number, gamma: number): IsentropicState {
  const temperatureRatio = 1 / stagnationTemperatureFactor(mach, gamma);
  return {
    mach,
    temperatureRatio,
    pressureRatio: temperatureRatio ** (gamma / (gamma - 1)),
    densityRatio: temperatureRatio ** (1 / (gamma - 1)),
    areaRatio: areaRatio(mach, gamma),
    prandtlMeyerDeg: prandtlMeyer(mach, gamma) * DEG,
    machAngleDeg: mach > 1 ? Math.asin(1 / mach) * DEG : 90,
  };
}

/** Largest Mach searched by the inverses (A/A* ≈ 1e8 at γ 1.4). */
export const MAX_MACH = 100;

/** Mach of a given A/A* ≥ 1 on the subsonic or supersonic branch (A/A* is monotone on each). */
export function machFromAreaRatio(ratio: number, gamma: number, branch: 'subsonic' | 'supersonic'): number {
  if (ratio <= 1) return 1;
  const range =
    branch === 'subsonic'
      ? bisect((mach) => areaRatio(mach, gamma) > ratio, 1e-9, 1, 200)
      : bisect((mach) => areaRatio(mach, gamma) < ratio, 1, MAX_MACH, 200);
  return (range.low + range.high) / 2;
}

/** Mach from p / p0 in (0, 1] (closed form). */
export const machFromPressureRatio = (ratio: number, gamma: number): number =>
  Math.sqrt((2 / (gamma - 1)) * (ratio ** (-(gamma - 1) / gamma) - 1));

/** Mach from T / T0 in (0, 1] (closed form). */
export const machFromTemperatureRatio = (ratio: number, gamma: number): number => Math.sqrt((2 / (gamma - 1)) * (1 / ratio - 1));

/** Mach from a Prandtl-Meyer angle in radians (0 ≤ ν < ν_max). */
export function machFromPrandtlMeyer(nu: number, gamma: number): number {
  const range = bisect((mach) => prandtlMeyer(mach, gamma) < nu, 1, MAX_MACH, 200);
  return (range.low + range.high) / 2;
}

/** ν_max = (π/2)(√((γ+1)/(γ-1)) - 1), radians. */
export const maxPrandtlMeyer = (gamma: number): number => (Math.PI / 2) * (Math.sqrt((gamma + 1) / (gamma - 1)) - 1);
