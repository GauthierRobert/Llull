/**
 * Hill-1948 anisotropic yield (PHY-02 §5.3, V2). Equivalent stress σ̄² = F(σ22−σ33)² + G(σ33−σ11)² + H(σ11−σ22)² + 2Lσ23² + 2Mσ13² + 2Nσ12²
 * in the material axes (1 = rolling, 2 = transverse, 3 = thickness), normalised so that the isotropic hardening curve is the flow stress
 * σ̄. Associative flow, work-conjugate hardening (Δε̄p = Δλ since σ̄ is homogeneous of degree 1). Backward-Euler return mapping solved
 * on the scalar Δλ: σ(Δλ) = (I + Δλ C P/σ_y(ε̄p_n + Δλ))⁻¹ σ_tr, residual σ̄(σ(Δλ)) − σ_y(ε̄p_n + Δλ).
 */

import type { J2State } from './j2';
import { solveLinear, type Matrix } from './linalg';
import { solveDecreasing } from './scalar';
import { zero6, type Vec6 } from './tensor';

export interface HillCoefficients {
  readonly F: number;
  readonly G: number;
  readonly H: number;
  readonly L: number;
  readonly M: number;
  readonly N: number;
}

export interface HillMaterial {
  /** Elastic stiffness (Voigt, engineering shear). */
  readonly C: Matrix;
  /** Quadratic form of the equivalent stress: σ̄² = σᵀPσ (Voigt, tensor shear stresses). */
  readonly P: Matrix;
  readonly yieldStress: (equivalentPlasticStrain: number) => number;
  readonly referenceYield: number;
}

/** P matrix of the quadratic form. */
export function hillMatrix({ F, G, H, L, M, N }: HillCoefficients): Matrix {
  const p: Matrix = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  const set = (i: number, j: number, value: number): void => {
    (p[i] as number[])[j] = value;
    (p[j] as number[])[i] = value;
  };
  set(0, 0, G + H);
  set(1, 1, F + H);
  set(2, 2, F + G);
  set(0, 1, -H);
  set(0, 2, -G);
  set(1, 2, -F);
  set(3, 3, 2 * N);
  set(4, 4, 2 * M);
  set(5, 5, 2 * L);
  return p;
}

const quadratic = (p: Matrix, s: readonly number[]): number =>
  s.reduce((sum, value, i) => sum + value * (p[i] ?? []).reduce((row, entry, j) => row + entry * (s[j] ?? 0), 0), 0);

/** σ̄ = √(σᵀ P σ) (0 when the form is numerically negative). */
export const hillEquivalent = (p: Matrix, stress: readonly number[]): number => Math.sqrt(Math.max(quadratic(p, stress), 0));

/** Flow direction ∂σ̄/∂σ = Pσ/σ̄ in the engineering-strain conjugate of the Voigt stress (zero vector at σ̄ = 0). */
export function hillFlowDirection(p: Matrix, stress: readonly number[]): Vec6 {
  const equivalent = hillEquivalent(p, stress);
  return equivalent > 0 ? p.map((row) => row.reduce((sum, entry, j) => sum + entry * (stress[j] ?? 0), 0) / equivalent) : zero6();
}

/**
 * Coefficients from the Abaqus yield-stress ratios R_ij = σ_ij/σ0 (R12, R13, R23 are √3 τ_ij/σ0).
 * @failure any ratio ≤ 0 -> null
 */
export function coefficientsFromStressRatios(r: {
  R11: number;
  R22: number;
  R33: number;
  R12: number;
  R13: number;
  R23: number;
}): HillCoefficients | null {
  if (![r.R11, r.R22, r.R33, r.R12, r.R13, r.R23].every((value) => Number.isFinite(value) && value > 0)) return null;
  const a = 1 / (r.R11 * r.R11);
  const b = 1 / (r.R22 * r.R22);
  const c = 1 / (r.R33 * r.R33);
  return {
    F: 0.5 * (b + c - a),
    G: 0.5 * (c + a - b),
    H: 0.5 * (a + b - c),
    L: 1.5 / (r.R23 * r.R23),
    M: 1.5 / (r.R13 * r.R13),
    N: 1.5 / (r.R12 * r.R12),
  };
}

/**
 * Coefficients from the Lankford ratios r0, r45, r90 of a sheet (width/thickness plastic strain ratio at 0°, 45°, 90° to the rolling
 * direction), normalised to the rolling-direction yield stress (G + H = 1); out-of-plane shear isotropic (L = M = 3/2).
 * @failure any r ≤ 0 -> null
 */
export function coefficientsFromRValues(r0: number, r45: number, r90: number): HillCoefficients | null {
  if (![r0, r45, r90].every((value) => Number.isFinite(value) && value > 0)) return null;
  const F = r0 / (r90 * (1 + r0));
  const G = 1 / (1 + r0);
  return { F, G, H: r0 / (1 + r0), L: 1.5, M: 1.5, N: ((F + G) * (1 + 2 * r45)) / 2 };
}

/** Convex iff the deviatoric form is positive definite (G + H > 0, FG + GH + HF > 0) and the shear coefficients are positive. */
export const hillIsConvex = ({ F, G, H, L, M, N }: HillCoefficients): boolean =>
  G + H > 0 && F * G + G * H + H * F > 0 && L > 0 && M > 0 && N > 0;

export const initialHillState = (): J2State => ({ stress: zero6(), equivalentPlasticStrain: 0, back: [] });

export interface HillUpdate {
  readonly state: J2State;
  readonly plasticMultiplier: number;
  readonly iterations: number;
}

const addScaled = (a: readonly number[], b: readonly number[], scale: number): Vec6 => a.map((value, i) => value + scale * (b[i] ?? 0));

/**
 * One increment of the Hill return mapping.
 * @invariant elastic when σ̄_tr ≤ σ_y(ε̄p_n)(1 + 1e-12); otherwise σ̄(σ_{n+1}) = σ_y(ε̄p_n + Δλ) to 1e-10 σ_y
 * @failure the scalar solve or a linear solve does not converge -> null
 */
export function hillUpdate(material: HillMaterial, state: J2State, dEps: readonly number[]): HillUpdate | null {
  const { C, P } = material;
  const trial = addScaled(
    state.stress,
    C.map((row) => row.reduce((sum, entry, j) => sum + entry * (dEps[j] ?? 0), 0)),
    1,
  );
  const trialEquivalent = hillEquivalent(P, trial);
  const yieldBefore = material.yieldStress(state.equivalentPlasticStrain);
  if (trialEquivalent <= yieldBefore * (1 + 1e-12)) return { state: { ...state, stress: trial }, plasticMultiplier: 0, iterations: 0 };
  const CP: Matrix = C.map((row) => (P[0] ?? []).map((_, j) => row.reduce((sum, entry, k) => sum + entry * (P[k]?.[j] ?? 0), 0)));
  const stressAt = (multiplier: number): Vec6 | null => {
    const flow = multiplier / material.yieldStress(state.equivalentPlasticStrain + multiplier);
    const system = CP.map((row, i) => row.map((entry, j) => (i === j ? 1 : 0) + flow * entry));
    return solveLinear(system, trial);
  };
  const residual = (multiplier: number): number => {
    const stress = stressAt(multiplier);
    return stress === null ? Number.NaN : hillEquivalent(P, stress) - material.yieldStress(state.equivalentPlasticStrain + multiplier);
  };
  const smallestStiffness = Math.min(...C.map((row, i) => row[i] ?? Number.POSITIVE_INFINITY));
  let hi = trialEquivalent / smallestStiffness + Number.MIN_VALUE;
  for (let i = 0; i < 60 && residual(hi) > 0; i += 1) hi *= 2;
  const solved = solveDecreasing(residual, 0, hi, 1e-10 * material.referenceYield);
  if (solved === null) return null;
  const stress = stressAt(solved.x);
  if (stress === null) return null;
  return {
    state: { stress, equivalentPlasticStrain: state.equivalentPlasticStrain + solved.x, back: [] },
    plasticMultiplier: solved.x,
    iterations: solved.iterations,
  };
}
