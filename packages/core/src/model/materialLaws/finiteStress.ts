/**
 * Cauchy stress of a compressible isotropic hyperelastic law at a general deformation gradient (PHY-02 §5.6, V2): spectral decomposition of
 * b = F Fᵀ, deviatoric Kirchhoff stresses from W(λ̄1, λ̄2, λ̄3) (invariant laws through W1, W2; Ogden through the exponents), plus the
 * volumetric pressure U'(J). W = W_dev(λ̄) + U(J), λ̄ = J^(−1/3) λ.
 */

import { symmetricEigen } from './eigen';
import { strainEnergy, type ResolvedHyper } from './hyperelastic';
import type { Volumetric } from './hyperVolumetric';
import type { Vec6 } from './tensor';

export type Mat3 = number[][];

export interface CompressibleLaw {
  readonly iso: ResolvedHyper;
  readonly vol: Volumetric;
}

export interface FiniteResponse {
  /** Cauchy stress, Voigt [11, 22, 33, 12, 13, 23], tensor shear (MPa). */
  readonly stress: Vec6;
  /** First Piola-Kirchhoff stress P = J σ F⁻ᵀ (MPa). */
  readonly nominal: Mat3;
  readonly volumeRatio: number;
  /** Principal stretches, largest first. */
  readonly principal: readonly [number, number, number];
  /** Hencky (logarithmic) strain, Voigt with engineering shear. */
  readonly hencky: Vec6;
  /** W_dev + U (MPa = MJ/m³). */
  readonly energy: number;
}

const at = (m: readonly (readonly number[])[], i: number, j: number): number => m[i]?.[j] ?? 0;

export const identity3 = (): Mat3 => [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function determinant3(m: readonly (readonly number[])[]): number {
  return (
    at(m, 0, 0) * (at(m, 1, 1) * at(m, 2, 2) - at(m, 1, 2) * at(m, 2, 1)) -
    at(m, 0, 1) * (at(m, 1, 0) * at(m, 2, 2) - at(m, 1, 2) * at(m, 2, 0)) +
    at(m, 0, 2) * (at(m, 1, 0) * at(m, 2, 1) - at(m, 1, 1) * at(m, 2, 0))
  );
}

/** Inverse of a 3×3 matrix by cofactors; null when singular. */
function inverse3(m: readonly (readonly number[])[]): Mat3 | null {
  const det = determinant3(m);
  if (!(Math.abs(det) > 1e-300)) return null;
  const cof = (i: number, j: number): number => {
    const r = [0, 1, 2].filter((k) => k !== i) as [number, number];
    const c = [0, 1, 2].filter((k) => k !== j) as [number, number];
    return (-1) ** (i + j) * (at(m, r[0], c[0]) * at(m, r[1], c[1]) - at(m, r[0], c[1]) * at(m, r[1], c[0]));
  };
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => cof(j, i) / det));
}

const product = (a: readonly (readonly number[])[], b: readonly (readonly number[])[]): Mat3 =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => at(a, i, 0) * at(b, 0, j) + at(a, i, 1) * at(b, 1, j) + at(a, i, 2) * at(b, 2, j)));

/** Σ v_k n_k n_kᵀ. */
function fromPrincipal(values: readonly number[], vectors: readonly (readonly number[])[]): Mat3 {
  return [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => values.reduce((sum, v, k) => sum + v * (vectors[k]?.[i] ?? 0) * (vectors[k]?.[j] ?? 0), 0)),
  );
}

const voigt = (m: Mat3, shearFactor: number): Vec6 => [
  at(m, 0, 0),
  at(m, 1, 1),
  at(m, 2, 2),
  shearFactor * at(m, 0, 1),
  shearFactor * at(m, 0, 2),
  shearFactor * at(m, 1, 2),
];

/** Deviatoric Kirchhoff principal stresses τ_i of W_dev at the isochoric stretches. */
function deviatoricKirchhoff(iso: ResolvedHyper, bar: readonly [number, number, number]): number[] {
  if (iso.kind === 'ogden') {
    return bar.map((x) =>
      iso.mu.reduce((sum, mu, k) => {
        const alpha = iso.alpha[k] ?? 1;
        const mean = (bar[0] ** alpha + bar[1] ** alpha + bar[2] ** alpha) / 3;
        return sum + ((2 * mu) / alpha) * (x ** alpha - mean);
      }, 0),
    );
  }
  const squares = bar.map((x) => x * x);
  const [s0 = 0, s1 = 0, s2 = 0] = squares;
  const i1 = s0 + s1 + s2;
  const i2 = s0 * s1 + s1 * s2 + s2 * s0;
  const { W1, W2 } = iso.derivatives(i1, i2);
  const x = squares.map((s) => W1 * s + W2 * (i1 * s - s * s));
  const mean = x.reduce((sum, value) => sum + value, 0) / 3;
  return x.map((value) => 2 * (value - mean));
}

/**
 * Response of the law at F.
 * @failure det F ≤ 0 or a non-finite stress -> null
 */
export function finiteResponse(law: CompressibleLaw, F: Mat3): FiniteResponse | null {
  const J = determinant3(F);
  if (!(J > 0)) return null;
  const left = product(
    F,
    [0, 1, 2].map((i) => [0, 1, 2].map((j) => at(F, j, i))),
  );
  const { values, vectors } = symmetricEigen(left);
  const stretches = values.map((value) => Math.sqrt(Math.max(value, 0)));
  if (stretches.some((value) => !(value > 0))) return null;
  const volumeRatio = stretches.reduce((product_, value) => product_ * value, 1);
  const isochoric = volumeRatio ** (-1 / 3);
  const bar = stretches.map((value) => value * isochoric) as [number, number, number];
  const pressure = law.vol.pressure(volumeRatio);
  const principalStress = deviatoricKirchhoff(law.iso, bar).map((tau) => tau / volumeRatio + pressure);
  const cauchy = fromPrincipal(principalStress, vectors);
  const inverse = inverse3(F);
  if (inverse === null || principalStress.some((value) => !Number.isFinite(value))) return null;
  const nominal = product(
    cauchy.map((row) => row.map((value) => value * volumeRatio)),
    [0, 1, 2].map((i) => [0, 1, 2].map((j) => at(inverse, j, i))),
  );
  const energy = strainEnergy(law.iso, bar) + law.vol.energy(volumeRatio);
  return {
    stress: voigt(cauchy, 1),
    nominal,
    volumeRatio,
    principal: [...stretches].sort((a, b) => b - a) as [number, number, number],
    hencky: voigt(fromPrincipal(stretches.map(Math.log), vectors), 2),
    energy,
  };
}
