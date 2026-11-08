/** PHY-11 §5.2 closed forms of creep and viscoelastic time response (pure; mirrors validation/generate_creep_reference.py). Units are those of the caller. */

import { nortonCreepStrain } from '@core/model/materialLaws/creep';

/** Norton creep strain ε = A σⁿ t^(m+1)/(m+1) at constant stress (time hardening, m > −1). */
export const nortonStrain = nortonCreepStrain;

/** Stress of a bar held at fixed total strain after time t: [σ0^(1−n) + (n−1) E′ A t]^(1/(1−n)); n = 1 gives σ0 exp(−E′ A t). */
export function relaxedStress(sigma0: number, effectiveModulus: number, A: number, n: number, t: number): number {
  if (n === 1) return sigma0 * Math.exp(-effectiveModulus * A * t);
  return (sigma0 ** (1 - n) + (n - 1) * effectiveModulus * A * t) ** (1 / (1 - n));
}

/** Time for the stress to fall to `fraction` × σ0 (0 < fraction < 1): σ0^(1−n)(f^(1−n) − 1)/((n−1) E′ A); n = 1 gives −ln f/(E′ A). */
export function timeToFraction(sigma0: number, effectiveModulus: number, A: number, n: number, fraction: number): number {
  if (n === 1) return -Math.log(fraction) / (effectiveModulus * A);
  return (sigma0 ** (1 - n) * (fraction ** (1 - n) - 1)) / ((n - 1) * effectiveModulus * A);
}

/** E′ = E k_m/(k_m + k_b) = E/(1 + k_b/k_m) of a bolt in series with members (k_b/k_m = 0: rigid members). */
export const boltEffectiveModulus = (E: number, boltOverMemberStiffness: number): number => E / (1 + boltOverMemberStiffness);

export interface TubeStress {
  readonly radial: number;
  readonly hoop: number;
  readonly axial: number;
  readonly vonMises: number;
}

/**
 * Stationary Norton creep of a thick tube under internal pressure p (plane strain, incompressible flow): σr = −p[(b/r)^(2/n) − 1]/[(b/a)^(2/n) − 1],
 * σθ = p[1 + (2/n − 1)(b/r)^(2/n)]/[(b/a)^(2/n) − 1], σz = (σr + σθ)/2, σeq = (√3/2)(σθ − σr). n = 1 is Lamé.
 */
export function tubeStationary(p: number, a: number, b: number, n: number, r: number): TubeStress {
  const k = 2 / n;
  const denominator = (b / a) ** k - 1;
  const q = (b / r) ** k;
  const radial = (-p * (q - 1)) / denominator;
  const hoop = (p * (1 + (k - 1) * q)) / denominator;
  return { radial, hoop, axial: 0.5 * (radial + hoop), vonMises: (Math.sqrt(3) / 2) * (hoop - radial) };
}

/** Stationary creep bending stress of a b × h rectangle at height y from the neutral axis: σ = M |y|^(1/n) sign(y)/Iₙ, Iₙ = 2b(h/2)^(2+1/n)/(2+1/n). */
export function beamStationary(M: number, b: number, h: number, n: number, y: number): number {
  const In = (2 * b * (h / 2) ** (2 + 1 / n)) / (2 + 1 / n);
  return Math.sign(y) * ((M * Math.abs(y) ** (1 / n)) / In);
}

/** Elastic outer-fibre bending stress 6M/(b h²). */
export const beamElasticOuter = (M: number, b: number, h: number): number => (6 * M) / (b * h * h);

/** Generalized Maxwell (Prony) relaxation modulus E(t) = E∞ + Σ Eᵢ exp(−t/τᵢ). */
export const pronyModulus = (Einf: number, terms: readonly { readonly E: number; readonly tau: number }[], t: number): number =>
  Einf + terms.reduce((sum, term) => sum + term.E * Math.exp(-t / term.tau), 0);

/** Standard linear solid creep compliance J(t) = 1/E∞ − E1/(E0 E∞) exp(−t E∞/(τ E0)), E0 = E∞ + E1. */
export function slsCompliance(Einf: number, E1: number, tau: number, t: number): number {
  const E0 = Einf + E1;
  return 1 / Einf - (E1 / (E0 * Einf)) * Math.exp((-t * Einf) / (tau * E0));
}

/** Kelvin–Voigt creep compliance J(t) = (1 − exp(−t/τ))/E. */
export const kelvinVoigtCompliance = (E: number, tau: number, t: number): number => (1 - Math.exp(-t / tau)) / E;

/** WLF shift log10 aT = −C1 ΔT/(C2 + ΔT) (ΔT = T − Tr, same unit as C2). */
export const wlfLogShift = (c1: number, c2: number, deltaT: number): number => (-c1 * deltaT) / (c2 + deltaT);
