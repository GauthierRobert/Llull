/** Creep rate kernels (PHY-02 §5.8): Norton time hardening (CalculiX form) and Garofalo. Units are those of the caller. */

import { GAS_CONSTANT } from '../propertyForms';

/** Effective time ∫ t^m dt over [t0, t1] (m > −1). */
export const nortonEffectiveTime = (m: number, t0: number, t1: number): number => (t1 ** (m + 1) - t0 ** (m + 1)) / (m + 1);

/** Norton creep strain ε = A σ^n t^(m+1)/(m+1) at constant stress (time hardening). */
export const nortonCreepStrain = (A: number, n: number, m: number, stress: number, t: number): number =>
  A * stress ** n * nortonEffectiveTime(m, 0, t);

/** Garofalo rate A [sinh(ασ)]^n exp(−Q/(R T)). */
export const garofaloRate = (A: number, alpha: number, n: number, activationEnergy: number, stress: number, temperature: number): number =>
  A * Math.sinh(alpha * stress) ** n * Math.exp(-activationEnergy / (GAS_CONSTANT * temperature));
