/**
 * Ply stresses recovered from the stresses at the two outer surfaces of a laminate (05 FEA ply-failure margins on composite shells).
 * Kirchhoff-Love: the strain varies linearly through the thickness, eps(z) = eps0 + z kappa, so the in-plane stresses of the top and bottom plies
 * (laminate axes) give the strains at z = +h/2 and z = -h/2 through the inverse of their reduced stiffness; eps0 and kappa follow, and every ply
 * stress is Qbar eps(z) (`plyStressAt`). Exact for a CLT laminate; transverse shear and interlaminar stresses are not recovered.
 */

import { type StackPly, type Triple, invert, laminateStiffness, plyStressAt, reducedStiffness, transformedStiffness } from './clt';

export interface RecoveredPly {
  /** Stresses in the material axes (s1, s2, t12), MPa, at the bottom (tool-side) and the top surface of the ply. */
  readonly bottom: Triple;
  readonly top: Triple;
}

/** Strain (engineering shear) of the ply with `angle` under the laminate-axes stress `sigma` (MPa), or null when the stiffness is singular. */
function strainOf(ply: StackPly, sigma: Triple): Triple | null {
  const compliance = invert(transformedStiffness(reducedStiffness(ply.material), ply.angle));
  if (compliance === null) return null;
  const strain = compliance.map((row) => row.reduce((sum, value, j) => sum + value * (sigma[j] as number), 0));
  return [strain[0] as number, strain[1] as number, strain[2] as number];
}

/**
 * Per-ply stresses of `stack` (bottom to top, thicknesses in mm) from `bottomXy` / `topXy` (sx, sy, txy in the laminate axes, MPa) at the outer surfaces.
 * @invariant feeding the outer-surface stresses of a CLT solution returns that solution's ply stresses (to round-off)
 * @failure empty stack, zero thickness or a singular ply stiffness -> null
 */
export function recoverPlyStresses(stack: readonly StackPly[], bottomXy: Triple, topXy: Triple): RecoveredPly[] | null {
  const first = stack[0];
  const last = stack[stack.length - 1];
  if (first === undefined || last === undefined) return null;
  const laminate = laminateStiffness(stack);
  if (!(laminate.thickness > 0)) return null;
  const [epsBottom, epsTop] = [strainOf(first, bottomXy), strainOf(last, topXy)];
  if (epsBottom === null || epsTop === null) return null;
  const strain = epsTop.map((value, i) => (value + (epsBottom[i] as number)) / 2) as unknown as Triple;
  const curvature = epsTop.map((value, i) => (value - (epsBottom[i] as number)) / laminate.thickness) as unknown as Triple;
  return stack.map((ply, index) => ({
    bottom: plyStressAt(ply.material, ply.angle, strain, curvature, laminate.z[index] as number).material,
    top: plyStressAt(ply.material, ply.angle, strain, curvature, laminate.z[index + 1] as number).material,
  }));
}
