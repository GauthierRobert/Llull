/** Prony-series viscoelasticity and time-temperature shift (PHY-02 §5.8). Temperatures in K, times in s. */

import { GAS_CONSTANT } from '../propertyForms';
import { failure, type LawFailure } from './resolve';

/** Relaxation ratio G(t)/G0 = 1 − Σ g_i (1 − e^(−t/τ_i)). */
export const pronyRatio = (g: readonly number[], tau: readonly number[], t: number): number =>
  1 - g.reduce((sum, gi, i) => sum + gi * (1 - Math.exp(-t / (tau[i] ?? 1))), 0);

/** log10 of the WLF shift factor; refused when C2 + T − Tr ≤ 0, or below Tr when Tr is the glass transition. */
export function wlfLog10Shift(
  C1: number,
  C2: number,
  referenceTemperature: number,
  referenceIsTg: boolean,
  temperature: number,
): number | LawFailure {
  const delta = temperature - referenceTemperature;
  if (C2 + delta <= 0 || (referenceIsTg && delta < 0)) {
    return failure(
      'MATL_SHIFT_OUT_OF_RANGE',
      'model.shift',
      `WLF is not valid at T = ${temperature} K (C2 + T − Tr = ${C2 + delta}${referenceIsTg ? `, Tr = Tg = ${referenceTemperature} K` : ''})`,
      'stay at or above Tg / Tr',
    );
  }
  return (-C1 * delta) / (C2 + delta);
}

/** ln of the Arrhenius shift factor (Q/R)(1/T − 1/Tr), Q in J/mol. */
export const arrheniusLnShift = (activationEnergy: number, referenceTemperature: number, temperature: number): number =>
  (activationEnergy / GAS_CONSTANT) * (1 / temperature - 1 / referenceTemperature);

/**
 * Exponential recursion for one internal variable over a reduced-time step Δξ, exact for piecewise-linear strain:
 * h_{n+1} = e^(−Δξ/τ) h_n + (1 − e^(−Δξ/τ)) / (Δξ/τ) Δe.
 */
export function pronyRecursion(h: number, delta: number, reducedStep: number, tau: number): number {
  const ratio = reducedStep / tau;
  const decay = Math.exp(-ratio);
  return decay * h + (ratio > 1e-12 ? (1 - decay) / ratio : 1 - ratio / 2) * delta;
}
