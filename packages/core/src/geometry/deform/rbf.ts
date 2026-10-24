/**
 * Displacement field fitted to pairs of curves (01 DEF M5, FR-DEF-18): p goes to p + a0 + A p + Σ w_i |p − c_i|³ (the triharmonic spline in 3D, C2, whose
 * conditionally positive definite kernel r³ needs only an affine tail). The centres c_i are samples of the initial curves, the data the displacements that
 * carry them onto the matching samples of the target curves (equal normalised arc length), plus zero displacements at fixed points. `smoothing` > 0
 * relaxes the interpolation (a stiffer body): (K + smoothing I) w + P a = d.
 * @invariant smoothing 0 interpolates every constraint exactly; the map is C2 everywhere (r³ has no kink at a centre, so the exact fit converges at the usual rate)
 */

import type { DeformLaw } from '../../model/deform';
import type { Vec3 } from '../../model/vectors';
import { curveDerivatives, curveDomain } from '../../lib/nurbs/evaluate';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { len3 } from '../../lib/vec3';

export type RbfLaw = Extract<DeformLaw, { kind: 'rbf' }>;

/** Most constraints (dense solve of size n + 4). */
export const MAX_RBF_CENTRES = 400;

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Length scale of the field: a sixth of the diagonal of the box of its centres (the displacement varies over about that distance). */
export function rbfFeatureSize(law: RbfLaw): number {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < law.centres.length / 3; i++)
    for (let a = 0; a < 3; a++) {
      low[a] = Math.min(low[a] as number, law.centres[3 * i + a] as number);
      high[a] = Math.max(high[a] as number, law.centres[3 * i + a] as number);
    }
  return Math.max(Math.hypot(high[0]! - low[0]!, high[1]! - low[1]!, high[2]! - low[2]!) / 6, 1e-9);
}

/** The image of local point `q`. */
export function rbfMap(law: RbfLaw, q: Vec3): Vec3 {
  const out: [number, number, number] = [
    q[0] +
      (law.affine[0] as number) +
      (law.affine[3] as number) * q[0] +
      (law.affine[4] as number) * q[1] +
      (law.affine[5] as number) * q[2],
    q[1] +
      (law.affine[1] as number) +
      (law.affine[6] as number) * q[0] +
      (law.affine[7] as number) * q[1] +
      (law.affine[8] as number) * q[2],
    q[2] +
      (law.affine[2] as number) +
      (law.affine[9] as number) * q[0] +
      (law.affine[10] as number) * q[1] +
      (law.affine[11] as number) * q[2],
  ];
  for (let i = 0; i < law.centres.length / 3; i++) {
    const r = Math.hypot(
      q[0] - (law.centres[3 * i] as number),
      q[1] - (law.centres[3 * i + 1] as number),
      q[2] - (law.centres[3 * i + 2] as number),
    );
    for (const a of [0, 1, 2] as const) out[a] += r * r * r * (law.weights[3 * i + a] as number);
  }
  return out;
}

/** det J of the map at `q` (analytic: I + A + Σ 3 |q − c_i| w_i ⊗ (q − c_i)). */
export function rbfDeterminant(law: RbfLaw, q: Vec3): number {
  const j = [
    [1 + (law.affine[3] as number), law.affine[4] as number, law.affine[5] as number],
    [law.affine[6] as number, 1 + (law.affine[7] as number), law.affine[8] as number],
    [law.affine[9] as number, law.affine[10] as number, 1 + (law.affine[11] as number)],
  ] as [number[], number[], number[]];
  for (let i = 0; i < law.centres.length / 3; i++) {
    const d = [q[0] - (law.centres[3 * i] as number), q[1] - (law.centres[3 * i + 1] as number), q[2] - (law.centres[3 * i + 2] as number)];
    const r = Math.hypot(d[0] as number, d[1] as number, d[2] as number);
    if (r === 0) continue;
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++)
        (j[a] as number[])[b] = ((j[a] as number[])[b] as number) + 3 * r * (law.weights[3 * i + a] as number) * (d[b] as number);
  }
  const [x, y, z] = j as [number[], number[], number[]];
  return (
    (x[0] as number) * ((y[1] as number) * (z[2] as number) - (y[2] as number) * (z[1] as number)) -
    (x[1] as number) * ((y[0] as number) * (z[2] as number) - (y[2] as number) * (z[0] as number)) +
    (x[2] as number) * ((y[0] as number) * (z[1] as number) - (y[1] as number) * (z[0] as number))
  );
}

/** `count` points of `curve` at equal fractions of its arc length (including both ends). */
export function samplesByArcLength(curve: NurbsCurveData, count: number): Vec3[] {
  const [first, last] = curveDomain(curve);
  const steps = 512;
  const speed = (u: number): number => len3(curveDerivatives(curve, u, 1)[1] as Vec3);
  const params: number[] = [];
  const length: number[] = [0];
  for (let k = 0; k <= steps; k++) params.push(first + ((last - first) * k) / steps);
  for (let k = 0; k < steps; k++) {
    const [a, b] = [params[k] as number, params[k + 1] as number];
    length.push((length[k] as number) + ((b - a) / 6) * (speed(a) + 4 * speed((a + b) / 2) + speed(b)));
  }
  const total = length[steps] as number;
  const points: Vec3[] = [];
  for (let s = 0; s < count; s++) {
    const target = (total * s) / (count - 1);
    let lo = 0;
    let hi = steps;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((length[mid] as number) <= target) lo = mid;
      else hi = mid;
    }
    const [s0, s1, u0, u1] = [length[lo] as number, length[hi] as number, params[lo] as number, params[hi] as number];
    const u = s1 === s0 ? u0 : u0 + ((u1 - u0) * (target - s0)) / (s1 - s0);
    points.push(curveDerivatives(curve, u, 0)[0] as Vec3);
  }
  return points;
}

export interface RbfConstraint {
  readonly at: Vec3;
  readonly delta: Vec3;
}

/** Solves A x = b in place by Gaussian elimination with partial pivoting; false when singular. */
function solveDense(matrix: number[][], rhs: number[][]): boolean {
  const n = matrix.length;
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let r = column + 1; r < n; r++)
      if (Math.abs((matrix[r] as number[])[column] as number) > Math.abs((matrix[pivot] as number[])[column] as number)) pivot = r;
    if (Math.abs((matrix[pivot] as number[])[column] as number) < 1e-14) return false;
    [matrix[column], matrix[pivot]] = [matrix[pivot] as number[], matrix[column] as number[]];
    [rhs[column], rhs[pivot]] = [rhs[pivot] as number[], rhs[column] as number[]];
    const head = (matrix[column] as number[])[column] as number;
    for (let r = column + 1; r < n; r++) {
      const factor = ((matrix[r] as number[])[column] as number) / head;
      if (factor === 0) continue;
      for (let c = column; c < n; c++)
        (matrix[r] as number[])[c] = ((matrix[r] as number[])[c] as number) - factor * ((matrix[column] as number[])[c] as number);
      for (let c = 0; c < 3; c++)
        (rhs[r] as number[])[c] = ((rhs[r] as number[])[c] as number) - factor * ((rhs[column] as number[])[c] as number);
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    for (let c = 0; c < 3; c++) {
      let sum = rhs[r]?.[c] as number;
      for (let k = r + 1; k < n; k++) sum -= ((matrix[r] as number[])[k] as number) * ((rhs[k] as number[])[c] as number);
      (rhs[r] as number[])[c] = sum / ((matrix[r] as number[])[r] as number);
    }
  }
  return true;
}

/**
 * The displacement field through `constraints`.
 * @failure more than MAX_RBF_CENTRES distinct constraints, fewer than 1, or a point with two different displacements -> null
 */
export function fitRbf(requested: ReadonlyArray<RbfConstraint>, smoothing: number): RbfLaw | null {
  // a point named twice with the same displacement counts once; with different displacements the system is contradictory
  const constraints: RbfConstraint[] = [];
  for (const candidate of requested) {
    const twin = constraints.find(
      (known) => distance(known.at, candidate.at) <= 1e-9 * (1 + Math.abs(known.at[0]) + Math.abs(known.at[1]) + Math.abs(known.at[2])),
    );
    if (twin === undefined) constraints.push(candidate);
    else if (distance(twin.delta, candidate.delta) > 1e-9 * (1 + distance(twin.delta, [0, 0, 0]))) return null;
  }
  const n = constraints.length;
  if (n < 1 || n > MAX_RBF_CENTRES) return null;
  const size = n + 4;
  const matrix: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const rhs: number[][] = Array.from({ length: size }, () => [0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const [ci, di] = [(constraints[i] as RbfConstraint).at, (constraints[i] as RbfConstraint).delta];
    for (let j = 0; j < n; j++)
      (matrix[i] as number[])[j] = distance(ci, (constraints[j] as RbfConstraint).at) ** 3 + (i === j ? smoothing : 0);
    const tail = [1, ci[0], ci[1], ci[2]];
    for (let k = 0; k < 4; k++) {
      (matrix[i] as number[])[n + k] = tail[k] as number;
      (matrix[n + k] as number[])[i] = tail[k] as number;
    }
    rhs[i] = [di[0], di[1], di[2]];
  }
  // centres on a line or in a plane leave the linear tail underdetermined: a small ridge on its block picks the minimal-norm solution
  let reach = 1;
  for (const { at } of constraints) reach = Math.max(reach, Math.abs(at[0]), Math.abs(at[1]), Math.abs(at[2]));
  for (let k = 0; k < 4; k++) (matrix[n + k] as number[])[n + k] = -1e-10 * reach * reach;
  if (!solveDense(matrix, rhs)) return null;
  const weights: number[] = [];
  const centres: number[] = [];
  for (let i = 0; i < n; i++) {
    centres.push(...(constraints[i] as RbfConstraint).at);
    weights.push(...(rhs[i] as number[]));
  }
  // the tail rows are [a0; a_x; a_y; a_z] with one column per output axis: affine = a0 (3) then rows A (3 x 3)
  const [a0, ax, ay, az] = [rhs[n] as number[], rhs[n + 1] as number[], rhs[n + 2] as number[], rhs[n + 3] as number[]];
  const affine = [a0[0], a0[1], a0[2], ax[0], ay[0], az[0], ax[1], ay[1], az[1], ax[2], ay[2], az[2]] as number[];
  return { kind: 'rbf', centres, weights, affine };
}
