/** Expansion state and warnings of an ideal-nozzle result at its ambient pressure. */

import { sig } from '../shared/results';
import type { NozzleResult } from './rocketNozzle';

/** Summerfield criterion: flow separates when the exit pressure falls below ≈ 0.4 of ambient (Summerfield, Foster & Swan 1954). */
export const SUMMERFIELD_RATIO = 0.4;

/** Band around p_e / p_a = 1 reported as optimum expansion. */
const OPTIMUM_BAND = 0.02;

export type ExpansionState = 'vacuum' | 'optimum' | 'under-expanded' | 'over-expanded';

export const MODEL_LIMITATION =
  'Ideal 1D flow with one constant γ: with the CEA chamber γ the Isp is within ~3 % of shifting equilibrium, a frozen-composition expansion gives 4-6 % less; real engines deliver less still (RS-25: 452.3 s vs ~473 s ideal).';

export function expansionState(result: NozzleResult, ambientPressurePa: number): ExpansionState {
  if (ambientPressurePa === 0) return 'vacuum';
  const ratio = result.exitPressurePa / ambientPressurePa;
  return Math.abs(ratio - 1) < OPTIMUM_BAND ? 'optimum' : ratio > 1 ? 'under-expanded' : 'over-expanded';
}

/** Case-specific warnings, most severe first (the model limitation is reported separately). */
export function nozzleWarnings(result: NozzleResult, ambientPressurePa: number, ambientDefaulted: boolean): string[] {
  const ratio = ambientPressurePa > 0 ? result.exitPressurePa / ambientPressurePa : Number.POSITIVE_INFINITY;
  return [
    ...(ratio < SUMMERFIELD_RATIO
      ? [
          `p_e/p_a = ${sig(ratio)} < 0.4: the flow likely separates inside the nozzle (Summerfield); the ambient values assume attached flow.`,
        ]
      : ratio < 1
        ? [`over-expanded (p_e/p_a ${sig(ratio)}): thrust is below the optimum at this ambient.`]
        : []),
    ...(result.thrustCoefficient > 0
      ? []
      : [`no net thrust at this ambient pressure (C_F ${sig(result.thrustCoefficient)}): ambient Isp is null.`]),
    ...(ambientDefaulted ? ['ambient defaulted to vacuum (p_a = 0).'] : []),
  ];
}
