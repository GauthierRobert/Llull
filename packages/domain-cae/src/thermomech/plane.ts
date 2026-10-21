/** Least-squares plane of a point cloud and flatness (PHY-04 §5.4, TR-TMC-16): cyclic Jacobi on the 3 x 3 covariance, deterministic. */

import type { Vec3 } from '@core/model/vectors';
import { jacobiRotate } from '@lib/symmetricEigen';

export interface PlaneFit {
  readonly centroid: Vec3;
  /** Unit normal: eigenvector of the smallest covariance eigenvalue (sign fixed so its largest component is positive). */
  readonly normal: Vec3;
  /** max - min of the signed distances to the plane. */
  readonly flatness: number;
}

type Matrix3 = [[number, number, number], [number, number, number], [number, number, number]];

const SWEEPS = 60;
const PAIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [1, 2],
];

/** Eigen-decomposition of a symmetric 3 x 3 matrix by cyclic Jacobi rotations; returns eigenvalues and eigenvectors (columns of `vectors`). */
function jacobi(input: Matrix3): { values: Vec3; vectors: Matrix3 } {
  const a: Matrix3 = [[...input[0]], [...input[1]], [...input[2]]];
  const v: Matrix3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const at = (i: number, j: number): number => a[i]?.[j] ?? 0;
  const scale = Math.hypot(at(0, 0), at(1, 1), at(2, 2), at(0, 1), at(0, 2), at(1, 2));
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    if (Math.hypot(at(0, 1), at(0, 2), at(1, 2)) <= 1e-16 * scale) break;
    for (const [p, q] of PAIRS) {
      jacobiRotate(a, v, p, q);
    }
  }
  return { values: [at(0, 0), at(1, 1), at(2, 2)], vectors: v };
}

/**
 * Best-fit plane through `points` (at least three, not all collinear) and the flatness about it.
 * @failure fewer than 3 points or a degenerate (collinear / coincident) cloud -> null
 */
export function fitPlane(points: readonly Vec3[]): PlaneFit | null {
  if (points.length < 3) return null;
  const count = points.length;
  const centroid: Vec3 = [
    points.reduce((sum, p) => sum + p[0], 0) / count,
    points.reduce((sum, p) => sum + p[1], 0) / count,
    points.reduce((sum, p) => sum + p[2], 0) / count,
  ];
  const covariance: Matrix3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of points) {
    const d = [p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]];
    for (let i = 0; i < 3; i += 1)
      for (let j = 0; j < 3; j += 1) (covariance[i] as number[])[j] = (covariance[i]?.[j] ?? 0) + (d[i] ?? 0) * (d[j] ?? 0);
  }
  const { values, vectors } = jacobi(covariance);
  const order = [0, 1, 2].sort((i, j) => (values[i] ?? 0) - (values[j] ?? 0) || i - j);
  const [smallest = 0, middle = 1] = order;
  if (!((values[middle] ?? 0) > 1e-14 * Math.max(...values.map(Math.abs)))) return null;
  const column = [vectors[0]?.[smallest] ?? 0, vectors[1]?.[smallest] ?? 0, vectors[2]?.[smallest] ?? 0];
  const dominant = column.reduce((best, c, i) => (Math.abs(c) > Math.abs(column[best] ?? 0) + 1e-12 ? i : best), 0);
  const flip = (column[dominant] ?? 1) < 0 ? -1 : 1;
  const normal: Vec3 = [flip * (column[0] ?? 0), flip * (column[1] ?? 0), flip * (column[2] ?? 0)];
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    const distance = (p[0] - centroid[0]) * normal[0] + (p[1] - centroid[1]) * normal[1] + (p[2] - centroid[2]) * normal[2];
    low = Math.min(low, distance);
    high = Math.max(high, distance);
  }
  return { centroid, normal, flatness: high - low };
}
