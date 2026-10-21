/**
 * Eigen-decomposition of a symmetric 3x3 matrix by cyclic Jacobi rotations: principal moments (ascending) and right-handed unit axes.
 * Deterministic: fixed sweep order, axes signed so their largest-magnitude component is positive.
 */

import type { Vec3 } from '../model/vectors';

/** Symmetric 3x3 as [xx, yy, zz, xy, xz, yz]. */
export type Symmetric3 = readonly [number, number, number, number, number, number];

export interface PrincipalAxes {
  /** Eigenvalues, ascending. */
  readonly moments: Vec3;
  /** Unit eigenvectors in the order of `moments`, right-handed (axes[0] x axes[1] = axes[2]). */
  readonly axes: readonly [Vec3, Vec3, Vec3];
}

const MAX_SWEEPS = 60;
const PAIRS = [
  [0, 1],
  [0, 2],
  [1, 2],
] as const;

type Matrix = number[][];

const at = (m: Matrix, i: number, j: number): number => m[i]?.[j] ?? 0;

/** Flips `v` so its largest |component| (first on ties) is positive. */
function signed(v: Vec3): Vec3 {
  const index = Math.abs(v[0]) >= Math.abs(v[1]) && Math.abs(v[0]) >= Math.abs(v[2]) ? 0 : Math.abs(v[1]) >= Math.abs(v[2]) ? 1 : 2;
  return (v[index] ?? 0) < 0 ? [-v[0] + 0, -v[1] + 0, -v[2] + 0] : v;
}

/** One Jacobi rotation zeroing a[p][q] of a symmetric matrix (in place); accumulates the rotation in `v` when given. A zero a[p][q] is a no-op. */
export function jacobiRotate(a: Matrix, v: Matrix | null, p: number, q: number): void {
  const apq = at(a, p, q);
  if (apq === 0) return;
  const theta = (at(a, q, q) - at(a, p, p)) / (2 * apq);
  const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
  const c = 1 / Math.sqrt(t * t + 1);
  const s = t * c;
  const n = a.length;
  for (let k = 0; k < n; k++) {
    const [akp, akq] = [at(a, k, p), at(a, k, q)];
    (a[k] as number[])[p] = c * akp - s * akq;
    (a[k] as number[])[q] = s * akp + c * akq;
  }
  for (let k = 0; k < n; k++) {
    const [apk, aqk] = [at(a, p, k), at(a, q, k)];
    (a[p] as number[])[k] = c * apk - s * aqk;
    (a[q] as number[])[k] = s * apk + c * aqk;
  }
  if (v === null) return;
  for (let k = 0; k < n; k++) {
    const [vkp, vkq] = [at(v, k, p), at(v, k, q)];
    (v[k] as number[])[p] = c * vkp - s * vkq;
    (v[k] as number[])[q] = s * vkp + c * vkq;
  }
}

/** Principal moments and axes of a symmetric 3x3 matrix; a non-finite input gives null. */
export function symmetricEigen(matrix: Symmetric3): PrincipalAxes | null {
  if (!matrix.every(Number.isFinite)) return null;
  const a: Matrix = [
    [matrix[0], matrix[3], matrix[4]],
    [matrix[3], matrix[1], matrix[5]],
    [matrix[4], matrix[5], matrix[2]],
  ];
  const v: Matrix = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const scale = Math.max(Math.abs(matrix[0]), Math.abs(matrix[1]), Math.abs(matrix[2]), 1e-300);
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    if (Math.abs(at(a, 0, 1)) + Math.abs(at(a, 0, 2)) + Math.abs(at(a, 1, 2)) <= 1e-17 * scale) break;
    for (const [p, q] of PAIRS) jacobiRotate(a, v, p, q);
  }
  const order = [0, 1, 2].sort((i, j) => at(a, i, i) - at(a, j, j) || i - j);
  const [i0, i1, i2] = [order[0] ?? 0, order[1] ?? 1, order[2] ?? 2];
  const column = (i: number): Vec3 => signed([at(v, 0, i), at(v, 1, i), at(v, 2, i)]);
  const [first, second, third] = [column(i0), column(i1), column(i2)];
  const cross: Vec3 = [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
  const handed: Vec3 = cross[0] * third[0] + cross[1] * third[1] + cross[2] * third[2] < 0 ? [-third[0], -third[1], -third[2]] : third;
  return { moments: [at(a, i0, i0), at(a, i1, i1), at(a, i2, i2)], axes: [first, second, handed] };
}
