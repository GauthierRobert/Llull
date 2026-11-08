/** PHY-11 TR-CRP-12: unit conversion of the Norton coefficient A in ε̇ = A σⁿ tᵐ. */

import { convertValue, isUnitFailure } from '@lib/quantity';

/** Factor 1 `from` = factor `to`, or the reason when either is not a unit of `dimensionOf` (MPa for stress, s for time). */
function factor(from: string, to: string, dimensionOf: 'MPa' | 's'): number | string {
  for (const unit of [from, to]) {
    const check = convertValue(1, unit, dimensionOf);
    if (isUnitFailure(check)) return `'${unit}' is not a ${dimensionOf === 'MPa' ? 'stress' : 'time'} unit (${check.message})`;
  }
  const ratio = convertValue(1, from, to);
  return isUnitFailure(ratio) ? ratio.message : ratio.value;
}

/**
 * A in the target units: a stress unit change σ_new = c_s σ_old gives A_new = A_old c_s^(−n); a time unit change t_old = c_t t_new gives A_new = A_old c_t^(m+1).
 * @failure a unit that is not a stress / time unit -> { problem }
 */
export function convertNortonA(
  A: number,
  n: number,
  m: number,
  from: { readonly stress: string; readonly time: string },
  to: { readonly stress: string; readonly time: string },
): { readonly A: number } | { readonly problem: string } {
  const stress = factor(from.stress, to.stress, 'MPa');
  if (typeof stress === 'string') return { problem: stress };
  const time = factor(to.time, from.time, 's');
  if (typeof time === 'string') return { problem: time };
  return { A: A * stress ** -n * time ** (m + 1) };
}
