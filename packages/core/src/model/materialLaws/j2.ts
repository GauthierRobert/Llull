/**
 * Small-strain J2 plasticity with isotropic elasticity (PHY-02 §5.3): backward-Euler return mapping with isotropic hardening and
 * Armstrong-Frederick back stresses (linear Prager = γ 0). Closed form for linear isotropic + linear kinematic hardening, a bracketed
 * scalar Newton otherwise. Stresses carry tensor shear, strains engineering shear.
 */

import { solveDecreasing } from './scalar';
import { deviator, equivalent, mean3, zero6, type Vec6 } from './tensor';

interface BackStressTerm {
  readonly C: number;
  readonly gamma: number;
}

export interface J2Material {
  readonly G: number;
  readonly K: number;
  readonly yieldStress: (equivalentPlasticStrain: number) => number;
  /** Slope of the isotropic curve when it is straight (closed form), else null. */
  readonly linearSlope: number | null;
  readonly backStresses: readonly BackStressTerm[];
  readonly rateFactor: ((plasticRate: number) => number) | null;
  /** Yield stress used for the residual tolerance (|r| ≤ 1e-10 σ_y). */
  readonly referenceYield: number;
}

export interface J2State {
  readonly stress: Vec6;
  readonly equivalentPlasticStrain: number;
  /** One back-stress tensor per term of `J2Material.backStresses`. */
  readonly back: readonly Vec6[];
}

export const initialJ2State = (material: J2Material): J2State => ({
  stress: zero6(),
  equivalentPlasticStrain: 0,
  back: material.backStresses.map(zero6),
});

export interface J2Update {
  readonly state: J2State;
  readonly plasticMultiplier: number;
  readonly iterations: number;
}

/** Elastic trial stress σ_n + C:Δε for isotropic (G, K). */
export function trialStress(G: number, K: number, stress: readonly number[], dEps: readonly number[]): Vec6 {
  const trace = (dEps[0] ?? 0) + (dEps[1] ?? 0) + (dEps[2] ?? 0);
  const out = zero6();
  for (let i = 0; i < 3; i += 1) out[i] = (stress[i] ?? 0) + 2 * G * ((dEps[i] ?? 0) - trace / 3) + K * trace;
  for (let i = 3; i < 6; i += 1) out[i] = (stress[i] ?? 0) + G * (dEps[i] ?? 0);
  return out;
}

/**
 * One increment of the return mapping.
 * @invariant elastic when q_tr ≤ σ_y(ε̄p_n)(1 + 1e-12); the plastic multiplier Δλ solves
 *   q(v) − (3/2) Δλ (2G + Σ (2/3) C_i/(1 + γ_i Δλ)) − σ_y(ε̄p_n + Δλ) rate(Δλ/Δt) = 0, v = s_tr − Σ X_i,n/(1 + γ_i Δλ)
 * @failure Newton not converged in 100 iterations -> null
 */
export function j2Update(material: J2Material, state: J2State, dEps: readonly number[], dt: number): J2Update | null {
  const { G, K } = material;
  const trial = trialStress(G, K, state.stress, dEps);
  const pressure = mean3(trial);
  const sTrial = deviator(trial);
  const sumBack = state.back.reduce<Vec6>((sum, x) => sum.map((value, i) => value + (x[i] ?? 0)), zero6());
  const qTrial = equivalent(sTrial.map((value, i) => value - (sumBack[i] ?? 0)));
  const yieldBefore = material.yieldStress(state.equivalentPlasticStrain);
  const rateFactorAt = (multiplier: number): number =>
    material.rateFactor === null ? 1 : material.rateFactor(dt > 0 ? multiplier / dt : 0);
  if (qTrial <= yieldBefore * rateFactorAt(0) * (1 + 1e-12))
    return { state: { ...state, stress: trial }, plasticMultiplier: 0, iterations: 0 };

  const terms = material.backStresses;
  const closedForm = material.linearSlope !== null && material.rateFactor === null && terms.every((term) => term.gamma === 0);
  const vectorV = (multiplier: number): Vec6 =>
    sTrial.map((value, i) => value - state.back.reduce((sum, x, k) => sum + (x[i] ?? 0) / (1 + (terms[k]?.gamma ?? 0) * multiplier), 0));
  const hardeningA = (multiplier: number): number =>
    2 * G + terms.reduce((sum, term) => sum + ((2 / 3) * term.C) / (1 + term.gamma * multiplier), 0);
  let multiplier: number;
  let iterations = 1;
  if (closedForm) {
    const kinematicSlope = terms.reduce((sum, term) => sum + term.C, 0);
    multiplier = (qTrial - yieldBefore) / (3 * G + (material.linearSlope ?? 0) + kinematicSlope);
  } else {
    const residual = (m: number): number =>
      equivalent(vectorV(m)) - 1.5 * m * hardeningA(m) - material.yieldStress(state.equivalentPlasticStrain + m) * rateFactorAt(m);
    let hi = equivalent(sTrial) / (3 * G) + Number.MIN_VALUE;
    for (let i = 0; i < 60 && residual(hi) > 0; i += 1) hi *= 2;
    const solved = solveDecreasing(residual, 0, hi, 1e-10 * material.referenceYield);
    if (solved === null) return null;
    multiplier = solved.x;
    iterations = solved.iterations;
  }
  const v = vectorV(multiplier);
  const qv = equivalent(v);
  const direction = qv > 0 ? v.map((value) => (1.5 * value) / qv) : zero6();
  const stress = sTrial.map((value, i) => value - 2 * G * multiplier * (direction[i] ?? 0) + (i < 3 ? pressure : 0));
  const back = state.back.map((x, k) => {
    const term = terms[k];
    const gamma = term?.gamma ?? 0;
    const C = term?.C ?? 0;
    return x.map((value, i) => (value + (2 / 3) * C * multiplier * (direction[i] ?? 0)) / (1 + gamma * multiplier));
  });
  return {
    state: { stress, equivalentPlasticStrain: state.equivalentPlasticStrain + multiplier, back },
    plasticMultiplier: multiplier,
    iterations,
  };
}

/** Sum of the back-stress tensors (reported as `backStress`). */
export const totalBackStress = (state: J2State): Vec6 =>
  state.back.reduce<Vec6>((sum, x) => sum.map((value, i) => value + (x[i] ?? 0)), zero6());

/** Work increment ½ (σ_n + σ_{n+1}) : Δε with engineering shear strains. */
export function workIncrement(before: readonly number[], after: readonly number[], dEps: readonly number[]): number {
  let work = 0;
  for (let i = 0; i < 6; i += 1) work += 0.5 * ((before[i] ?? 0) + (after[i] ?? 0)) * (dEps[i] ?? 0);
  return work;
}
