/**
 * Effective stiffness estimates of lattices (05 IMP FR-IMP-34): the affine, stretching-only homogenisation of a strut cell (Deshpande, Fleck & Ashby 2001,
 * J. Mech. Phys. Solids 49) and the Gibson & Ashby scaling law E_eff / Es = C rho^n (Cellular Solids, 2nd ed., 1997). Both are screening numbers, never allowables.
 * @invariant C_ijkl = (E_s / V) sum_beams A L n_i n_j n_k n_l (uniform strain, axial stiffness only): exact for a rigid (stretching-dominated) frame such as the octet truss
 *   (E = rho E_s / 9 along the cube axes), an upper bound for a bending-dominated one, where nodes relax and the true stiffness is far lower
 * @invariant every result carries unverified: true and reviewRequired: true
 */

import type { StrutSet } from '@core/geometry/field/program';
import type { Vec3 } from '@core/model/types';

interface AffineStiffness {
  /** E / E_s along x, y, z (null when the normal block of the stiffness is singular). */
  readonly youngRatio: readonly [number | null, number | null, number | null];
  /** Poisson ratios nu_xy, nu_yz, nu_zx (null when undefined). */
  readonly poisson: readonly [number | null, number | null, number | null];
  /** Shear stiffness G_yz, G_zx, G_xy over E_s. */
  readonly shearRatio: readonly [number, number, number];
  /** Bulk modulus K / E_s (stretch-only, uniform dilatation). */
  readonly bulkRatio: number;
}

const AXES = [0, 1, 2] as const;

/** Affine stiffness tensor (units of E_s) of the periodic beams of `set` with uniform area scaling from their radii. */
function affineStiffness(set: StrutSet, cell: Vec3): AffineStiffness {
  const volume = cell[0] * cell[1] * cell[2];
  const c = new Float64Array(36);
  const voigt = [
    [0, 0],
    [1, 1],
    [2, 2],
    [1, 2],
    [2, 0],
    [0, 1],
  ] as const;
  for (const beam of set.beams) {
    const [a, b] = [set.nodes[beam.a], set.nodes[beam.b]];
    if (a === undefined || b === undefined) continue;
    const d = AXES.map((axis) => b[axis] - a[axis]);
    const length = Math.hypot(...d);
    if (length === 0) continue;
    const n = d.map((v) => v / length);
    const area = Math.PI * ((beam.ra + beam.rb) / 2) ** 2;
    const weight = (area * length) / volume;
    voigt.forEach(([i, j], row) =>
      voigt.forEach(([k, l], col) => {
        c[row * 6 + col] =
          (c[row * 6 + col] as number) + weight * (n[i] as number) * (n[j] as number) * (n[k] as number) * (n[l] as number);
      }),
    );
  }
  const at = (row: number, col: number): number => c[row * 6 + col] as number;
  const normal = [0, 1, 2].map((r) => [0, 1, 2].map((q) => at(r, q)));
  const inverse = invert3(normal);
  const young = AXES.map((axis) => (inverse === null ? null : 1 / (inverse[axis]?.[axis] as number))) as [
    number | null,
    number | null,
    number | null,
  ];
  const poisson = [
    [0, 1],
    [1, 2],
    [2, 0],
  ].map(([i, j]) =>
    inverse === null ? null : -(inverse[j as number]?.[i as number] as number) / (inverse[i as number]?.[i as number] as number),
  ) as [number | null, number | null, number | null];
  const bulk = (at(0, 0) + at(1, 1) + at(2, 2) + 2 * (at(0, 1) + at(1, 2) + at(2, 0))) / 9;
  return { youngRatio: young, poisson, shearRatio: [at(3, 3), at(4, 4), at(5, 5)], bulkRatio: bulk };
}

/** Inverse of a 3x3 matrix, or null when it is singular (a mechanism in that block). */
function invert3(m: readonly (readonly number[])[]): number[][] | null {
  const v = (r: number, q: number): number => (m[r] as readonly number[])[q] as number;
  const cofactor = (r: number, q: number): number => {
    const [r1, r2] = [(r + 1) % 3, (r + 2) % 3];
    const [q1, q2] = [(q + 1) % 3, (q + 2) % 3];
    return v(r1, q1) * v(r2, q2) - v(r1, q2) * v(r2, q1);
  };
  const det = v(0, 0) * cofactor(0, 0) + v(0, 1) * cofactor(0, 1) + v(0, 2) * cofactor(0, 2);
  const scale = Math.max(...m.flat().map(Math.abs), 1e-300);
  if (Math.abs(det) < 1e-9 * scale ** 3) return null;
  return [0, 1, 2].map((r) => [0, 1, 2].map((q) => cofactor(q, r) / det));
}

export interface MechanicsInput {
  /** Relative density (solid fraction) the estimate is made at. */
  readonly rho: number;
  readonly cellClass: 'stretch' | 'bending' | null;
  /** Beams of the cell for the affine model, or null (TPMS). */
  readonly strut: { readonly set: StrutSet; readonly cell: Vec3; readonly rho1: number } | null;
  readonly baseMaterial?: { readonly youngModulusMpa: number; readonly source: string } | undefined;
  readonly scaling?: { readonly exponent: number; readonly coefficient: number } | undefined;
}

const MECHANICS_SOURCE =
  'Deshpande, Fleck & Ashby 2001 (affine stretch-only homogenisation); Gibson & Ashby, Cellular Solids 2nd ed. 1997 (E*/Es = C rho^n); screening estimate, not an allowable';

/** The `mechanics` block of lattice_properties. */
export function latticeMechanics(input: MechanicsInput): Record<string, unknown> {
  const { rho, cellClass, strut, baseMaterial, scaling } = input;
  const affine = strut === null ? null : affineStiffness(strut.set, strut.cell);
  const exponent = scaling?.exponent ?? (cellClass === 'stretch' ? 1 : cellClass === 'bending' ? 2 : null);
  const coefficient = scaling?.coefficient ?? null;
  const ratio = exponent === null || coefficient === null ? null : coefficient * rho ** exponent;
  const es = baseMaterial?.youngModulusMpa;
  const scale = strut === null ? 1 : rho / strut.rho1;
  return {
    law: 'E*/Es = C rho^n',
    method: 'affine stretch-only homogenisation (struts) and Gibson-Ashby scaling',
    source: MECHANICS_SOURCE,
    rho,
    exponent,
    exponentBasis:
      scaling !== undefined
        ? 'caller'
        : cellClass === null
          ? 'none (no verified law for this lattice: give scaling from coupon tests)'
          : 'class (stretch 1, bending 2)',
    coefficient,
    coefficientBasis: scaling !== undefined ? 'caller' : 'none: give scaling.coefficient (a named table is not shipped)',
    stiffnessRatio: ratio,
    youngModulusMpa: ratio !== null && es !== undefined ? ratio * es : null,
    affine:
      affine === null
        ? null
        : {
            youngRatio: affine.youngRatio.map((v) => (v === null ? null : v * scale)),
            poisson: affine.poisson,
            shearRatio: affine.shearRatio.map((v) => v * scale),
            bulkRatio: affine.bulkRatio * scale,
            valid: cellClass === 'stretch',
            note:
              cellClass === 'stretch'
                ? 'rigid frame: the affine estimate is exact for the pin-jointed truss (octet along the cube axes E = rho Es / 9)'
                : 'bending-dominated cell: the affine estimate is an UPPER bound (nodes relax); the real stiffness is far lower',
          },
    baseMaterial: baseMaterial === undefined ? null : { youngModulusMpa: baseMaterial.youngModulusMpa, source: baseMaterial.source },
    unverified: true,
    reviewRequired: true,
    warning: 'IMP_MECHANICS_UNVERIFIED',
  };
}
