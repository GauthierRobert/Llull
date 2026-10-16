/**
 * Ramberg-Osgood deformation plasticity (PHY-02 §5.3-5.4): E ε = σ + α (σe/σ0)^(n−1) σ in the CalculiX form, generalised to J2
 * deformation theory ε = S σ + (3/2)(α/E)(σe/σ0)^(n−1) s. Monotonic proportional loading only.
 */

import { solveLinear } from './linalg';
import { contract, deviator, vonMises, type Vec6 } from './tensor';

export interface RambergOsgoodMaterial {
  readonly E: number;
  readonly nu: number;
  readonly sigma0: number;
  readonly n: number;
  readonly alpha: number;
}

/** CalculiX parameters of the engineering form ε = σ/E + 0.002 (σ/σ0.2)^n: σ0 = σ0.2, α = 0.002 E/σ0.2. */
export const engineeringToCalculix = (E: number, sigma02: number): { readonly sigma0: number; readonly alpha: number } => ({
  sigma0: sigma02,
  alpha: (0.002 * E) / sigma02,
});

/** Total strain (engineering shear) for a stress state. */
export function roStrain(material: RambergOsgoodMaterial, stress: readonly number[]): Vec6 {
  const { E, nu, sigma0, n, alpha } = material;
  const trace = (stress[0] ?? 0) + (stress[1] ?? 0) + (stress[2] ?? 0);
  const s = deviator(stress);
  const equivalent = vonMises(stress);
  const plastic = equivalent > 0 ? ((1.5 * alpha) / E) * (equivalent / sigma0) ** (n - 1) : 0;
  const strain: Vec6 = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i += 1) strain[i] = ((1 + nu) * (stress[i] ?? 0) - nu * trace) / E + plastic * (s[i] ?? 0);
  for (let i = 3; i < 6; i += 1) strain[i] = (2 * (1 + nu) * (stress[i] ?? 0)) / E + 2 * plastic * (s[i] ?? 0);
  return strain;
}

export interface RoTarget {
  readonly kind: 'strain' | 'stress';
  readonly value: number;
}

export interface RoSolution {
  readonly stress: Vec6;
  readonly strain: Vec6;
}

/** Uniaxial inverse σ(ε) by the same solver (used by tests as a cross-check of the 1D formula). */
export const roUniaxialStrain = (material: RambergOsgoodMaterial, sigma: number): number =>
  sigma / material.E + (material.alpha / material.E) * (Math.abs(sigma) / material.sigma0) ** (material.n - 1) * sigma;

/**
 * Solve the mixed boundary problem of the deformation theory: strain targets on some components, stress targets on the rest.
 * Newton on the 6 unknown stresses with a finite-difference Jacobian and backtracking; starts from the elastic solution.
 * @failure no convergence in 60 iterations -> null
 */
export function roSolve(material: RambergOsgoodMaterial, targets: readonly RoTarget[]): RoSolution | null {
  const { E, sigma0 } = material;
  const residual = (stress: readonly number[], m: RambergOsgoodMaterial): number[] => {
    const strain = roStrain(m, stress);
    return targets.map((target, i) => (target.kind === 'strain' ? (strain[i] ?? 0) : (stress[i] ?? 0)) - target.value);
  };
  const scale = targets.map((target) => Math.max(Math.abs(target.value), target.kind === 'strain' ? (1e-3 * sigma0) / E : 1e-3 * sigma0));
  const norm = (r: readonly number[]): number => Math.max(...r.map((value, i) => Math.abs(value) / (scale[i] ?? 1)));
  let stress: Vec6 = [0, 0, 0, 0, 0, 0];
  for (const m of [{ ...material, alpha: 0 }, material]) {
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const r = residual(stress, m);
      if (norm(r) <= 1e-13) break;
      const jacobian: number[][] = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
      for (let j = 0; j < 6; j += 1) {
        const h = 1e-7 * Math.max(Math.abs(stress[j] ?? 0), sigma0);
        const bumped = [...stress];
        bumped[j] = (bumped[j] ?? 0) + h;
        const rj = residual(bumped, m);
        for (let i = 0; i < 6; i += 1) (jacobian[i] as number[])[j] = ((rj[i] ?? 0) - (r[i] ?? 0)) / h;
      }
      const step = solveLinear(
        jacobian,
        r.map((value) => -value),
      );
      if (step === null) return null;
      let factor = 1;
      let accepted = false;
      for (let tries = 0; tries < 30; tries += 1) {
        const candidate = stress.map((value, i) => value + factor * (step[i] ?? 0));
        if (norm(residual(candidate, m)) < norm(r)) {
          stress = candidate;
          accepted = true;
          break;
        }
        factor /= 2;
      }
      if (!accepted) break;
    }
  }
  if (!(norm(residual(stress, material)) <= 1e-10)) return null;
  return { stress, strain: roStrain(material, stress) };
}

/** Equivalent stress and the contraction used for loading-direction checks. */
export const roLoadingDirection = (stress: readonly number[]): Vec6 => {
  const s = deviator(stress);
  const norm = Math.sqrt(contract(s, s));
  return norm > 0 ? s.map((value) => value / norm) : [0, 0, 0, 0, 0, 0];
};
