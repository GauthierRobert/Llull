/**
 * Component drag build-up, CD0 = Σ Cf·FF·Q·S_wet / S_ref (Raymer, "Aircraft Design: A Conceptual Approach", §12.5). Only formulas
 * confirmed from a readable source are built (validation/data/vlm_references.json, sources S15–S16):
 *   Cf laminar 1.328/√Re (Raymer eq. 12.26); turbulent 0.455 / (log10 Re)^2.58 / (1 + 0.144 M²)^0.65 (eq. 12.27);
 *   partly laminar (OpenAeroStruct `viscous_drag.py`): Cf = (Cf_lam(k Re) − Cf_turb(k Re)) k + Cf_turb(Re), k = laminar fraction;
 *   FF lifting surface — raymer [1 + 0.6/(x/c)_m (t/c) + 100 (t/c)^4][1.34 M^0.18 (cos Λ_m)^0.28] (eq. 12.30),
 *   torenbeek 1 + 2.7 t/c + 100 (t/c)^4, hoerner 1 + 2 t/c + 60 (t/c)^4; body — torenbeek 1 + 2.2/f^1.5 + 3.8/f^3,
 *   hoerner 1 + 1.5/f^1.5 + 7/f^3 (OpenVSP parasite-drag documentation).
 */

import { skinFrictionCoefficient } from './skinFriction';

export type FormFactorModel = 'raymer' | 'torenbeek' | 'hoerner';

const laminarCf = (reynolds: number): number => skinFrictionCoefficient('laminar_blasius', reynolds);

const turbulentCf = (reynolds: number, mach: number): number =>
  skinFrictionCoefficient('turbulent_prandtl_schlichting', reynolds) / Math.pow(1 + 0.144 * mach * mach, 0.65);

/** Skin friction with a laminar fraction k of the reference length (0 = fully turbulent). */
export function skinFrictionMixed(reynolds: number, mach: number, laminarFraction: number): number {
  if (laminarFraction <= 0) return turbulentCf(reynolds, mach);
  const transition = laminarFraction * reynolds;
  return (laminarCf(transition) - turbulentCf(transition, mach)) * laminarFraction + turbulentCf(reynolds, mach);
}

export interface LiftingShape {
  readonly thicknessRatio: number;
  /** Chordwise position of maximum thickness (x/c)_m (raymer only). */
  readonly maxThicknessX: number;
  /** Sweep of the maximum-thickness line Λ_m in radians (raymer only). */
  readonly sweep: number;
}

export function liftingFormFactor(model: FormFactorModel, shape: LiftingShape, mach: number): number {
  const t = shape.thicknessRatio;
  if (model === 'torenbeek') return 1 + 2.7 * t + 100 * t ** 4;
  if (model === 'hoerner') return 1 + 2 * t + 60 * t ** 4;
  return (1 + (0.6 / shape.maxThicknessX) * t + 100 * t ** 4) * (1.34 * Math.pow(mach, 0.18) * Math.pow(Math.cos(shape.sweep), 0.28));
}

export function bodyFormFactor(model: Exclude<FormFactorModel, 'raymer'>, finenessRatio: number): number {
  const f = finenessRatio;
  return model === 'torenbeek' ? 1 + 2.2 / f ** 1.5 + 3.8 / f ** 3 : 1 + 1.5 / f ** 1.5 + 7 / f ** 3;
}

export const FORMULAS: Readonly<Record<string, string>> = {
  laminarCf: 'Cf = 1.328 / √Re (Raymer eq. 12.26, Blasius)',
  turbulentCf: 'Cf = 0.455 / (log10 Re)^2.58 / (1 + 0.144 M²)^0.65 (Raymer eq. 12.27)',
  mixedCf: 'Cf = (Cf_lam(k Re) − Cf_turb(k Re)) k + Cf_turb(Re), k = laminar fraction (OpenAeroStruct viscous_drag)',
  raymerLifting: 'FF = [1 + 0.6/(x/c)_m (t/c) + 100 (t/c)^4][1.34 M^0.18 (cos Λ_m)^0.28] (Raymer eq. 12.30)',
  torenbeekLifting: 'FF = 1 + 2.7 (t/c) + 100 (t/c)^4 (Torenbeek 1982, via the OpenVSP parasite-drag documentation)',
  hoernerLifting: 'FF = 1 + 2 (t/c) + 60 (t/c)^4 (Hoerner 1965, via the OpenVSP parasite-drag documentation)',
  torenbeekBody: 'FF = 1 + 2.2/f^1.5 + 3.8/f^3, f = l/d (Torenbeek 1982, via OpenVSP)',
  hoernerBody: 'FF = 1 + 1.5/f^1.5 + 7/f^3, f = l/d (Hoerner 1965, via OpenVSP)',
  buildUp: 'CD0 = Σ Cf FF Q S_wet / S_ref (Raymer §12.5 component build-up)',
};
