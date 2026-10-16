/** Linear elasticity (PHY-02 §5.1): stiffness and compliance in Voigt order [11, 22, 33, 12, 13, 23] with engineering shear strains. */

import { invertMatrix, pivotReport, type Matrix, type PivotReport } from './linalg';

export interface OrthotropicConstants {
  readonly E1: number;
  readonly E2: number;
  readonly E3: number;
  readonly nu12: number;
  readonly nu13: number;
  readonly nu23: number;
  readonly G12: number;
  readonly G13: number;
  readonly G23: number;
}

const zeroMatrix = (n: number): Matrix => Array.from({ length: n }, () => new Array<number>(n).fill(0));

/** Isotropic stiffness from E and ν. */
export function isotropicStiffness(E: number, nu: number): Matrix {
  const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
  const G = E / (2 * (1 + nu));
  const c = zeroMatrix(6);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) (c[i] as number[])[j] = i === j ? lambda + 2 * G : lambda;
    (c[i + 3] as number[])[i + 3] = G;
  }
  return c;
}

/** Orthotropic compliance S (symmetric: ν21 = ν12 E2/E1 …) from engineering constants. */
export function orthotropicCompliance(c: OrthotropicConstants): Matrix {
  const s = zeroMatrix(6);
  const set = (i: number, j: number, value: number): void => {
    (s[i] as number[])[j] = value;
    (s[j] as number[])[i] = value;
  };
  set(0, 0, 1 / c.E1);
  set(1, 1, 1 / c.E2);
  set(2, 2, 1 / c.E3);
  set(0, 1, -c.nu12 / c.E1);
  set(0, 2, -c.nu13 / c.E1);
  set(1, 2, -c.nu23 / c.E2);
  set(3, 3, 1 / c.G12);
  set(4, 4, 1 / c.G13);
  set(5, 5, 1 / c.G23);
  return s;
}

/** Transversely isotropic constants expanded to orthotropic (axis of symmetry 3 for plane '12', axis 1 for plane '23'). */
export function expandTransverselyIsotropic(
  plane: '12' | '23',
  Ep: number,
  Et: number,
  nuP: number,
  nuPT: number,
  Gt: number,
): OrthotropicConstants {
  const Gp = Ep / (2 * (1 + nuP));
  if (plane === '12') return { E1: Ep, E2: Ep, E3: Et, nu12: nuP, nu13: nuPT, nu23: nuPT, G12: Gp, G13: Gt, G23: Gt };
  const nuTP = (nuPT * Et) / Ep;
  return { E1: Et, E2: Ep, E3: Ep, nu12: nuTP, nu13: nuTP, nu23: nuP, G12: Gt, G13: Gt, G23: Gp };
}

/** Stiffness from a compliance, or null when the compliance is singular. */
export const stiffnessFromCompliance = (s: Matrix): Matrix | null => invertMatrix(s);

/** Expand 21 values (upper triangle, row-wise, Voigt order) to the symmetric 6×6 matrix. */
export function symmetricFromUpperTriangle(values: readonly number[]): Matrix {
  const c = zeroMatrix(6);
  let k = 0;
  for (let i = 0; i < 6; i += 1) {
    for (let j = i; j < 6; j += 1) {
      const value = values[k] ?? 0;
      (c[i] as number[])[j] = value;
      (c[j] as number[])[i] = value;
      k += 1;
    }
  }
  return c;
}

interface PoissonBound {
  readonly pair: '12' | '13' | '23';
  readonly nu: number;
  readonly limit: number;
  readonly satisfied: boolean;
}

export interface ElasticReport extends PivotReport {
  readonly matrix: 'compliance' | 'stiffness';
  readonly poissonBounds?: readonly PoissonBound[];
}

/** Orthotropic stability: PD of the compliance plus the Lempriere bounds |ν_ij| < √(E_i/E_j). */
export function orthotropicReport(c: OrthotropicConstants): ElasticReport {
  const bound = (pair: PoissonBound['pair'], nu: number, ei: number, ej: number): PoissonBound => ({
    pair,
    nu,
    limit: Math.sqrt(ei / ej),
    satisfied: Math.abs(nu) < Math.sqrt(ei / ej),
  });
  return {
    ...pivotReport(orthotropicCompliance(c)),
    matrix: 'compliance',
    poissonBounds: [bound('12', c.nu12, c.E1, c.E2), bound('13', c.nu13, c.E1, c.E3), bound('23', c.nu23, c.E2, c.E3)],
  };
}

export const stiffnessReport = (c: Matrix): ElasticReport => ({ ...pivotReport(c), matrix: 'stiffness' });

/** Engineering constants of a stiffness matrix (orthotropic reading: only the diagonal compliance block is used). */
export function stiffnessToEngineeringConstants(c: Matrix): OrthotropicConstants | null {
  const s = invertMatrix(c);
  if (s === null) return null;
  const at = (i: number, j: number): number => s[i]?.[j] ?? 0;
  return {
    E1: 1 / at(0, 0),
    E2: 1 / at(1, 1),
    E3: 1 / at(2, 2),
    nu12: -at(0, 1) / at(0, 0),
    nu13: -at(0, 2) / at(0, 0),
    nu23: -at(1, 2) / at(1, 1),
    G12: 1 / at(3, 3),
    G13: 1 / at(4, 4),
    G23: 1 / at(5, 5),
  };
}

/** Isotropic constants of the stiffness: bulk and shear modulus. */
export const bulkShear = (E: number, nu: number): { readonly K: number; readonly G: number } => ({
  K: E / (3 * (1 - 2 * nu)),
  G: E / (2 * (1 + nu)),
});
