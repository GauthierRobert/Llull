/** 3-2-1 statically determinate support (14 FLL): which global dofs to hold at three points so exactly the six rigid-body motions are removed. */

import type { Vec3 } from '@core/model/vectors';

type SupportDof = 'ux' | 'uy' | 'uz';
const AXES: readonly SupportDof[] = ['ux', 'uy', 'uz'];
const UNIT: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** Smallest relative pivot the 6 x 6 restraint matrix may have (about 5 % of the point spread): below it the support is refused as near-singular. */
const MIN_SUPPORT_PIVOT = 0.05;

export interface SupportPattern {
  /** Held dofs at point 1 (all three), point 2 (two), point 3 (one). */
  readonly dofs: readonly [readonly SupportDof[], readonly SupportDof[], readonly SupportDof[]];
  /** Smallest pivot of the rigid-body restraint matrix (1 = perfect, 0 = singular). */
  readonly conditioning: number;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const at = (values: readonly number[], index: number): number => values[index] ?? 0;
const axisOf = (axis: number): Vec3 => UNIT[axis] ?? [0, 0, 0];

/** Smallest pivot magnitude of a square matrix by complete-pivoting elimination (0 when singular). */
function smallestPivot(matrix: readonly (readonly number[])[]): number {
  const a = matrix.map((row) => [...row]);
  let smallest = Infinity;
  for (let k = 0; k < a.length; k++) {
    let best = 0;
    let bestRow = k;
    let bestColumn = k;
    for (let i = k; i < a.length; i++)
      for (let j = k; j < a.length; j++)
        if (Math.abs(at(a[i] ?? [], j)) > best) {
          best = Math.abs(at(a[i] ?? [], j));
          bestRow = i;
          bestColumn = j;
        }
    if (best < 1e-300) return 0;
    const swapped = a[bestRow] ?? [];
    a[bestRow] = a[k] ?? [];
    a[k] = swapped;
    for (const row of a) {
      const keep = at(row, k);
      row[k] = at(row, bestColumn);
      row[bestColumn] = keep;
    }
    smallest = Math.min(smallest, best);
    const pivotRow = a[k] ?? [];
    for (let i = k + 1; i < a.length; i++) {
      const row = a[i] ?? [];
      const factor = at(row, k) / at(pivotRow, k);
      for (let j = k; j < row.length; j++) row[j] = at(row, j) - factor * at(pivotRow, j);
    }
  }
  return smallest;
}

/**
 * The best 3-2-1 pattern of `points` (point 1 holds ux uy uz, point 2 two dofs, point 3 one): a rigid motion t + theta x (p - c) moves a point by
 * u, and holding dof e there is the row [e, (p - c) x e]; the 6 x 6 matrix of the nine candidate patterns is scored by its smallest pivot with
 * lengths scaled by the point spread (the centre c = the mean of the points).
 * @invariant the returned pattern has full rank 6 with pivot >= MIN_SUPPORT_PIVOT, else null (collinear or near-collinear points)
 */
export function bestSupportPattern(points: readonly [Vec3, Vec3, Vec3]): SupportPattern | null {
  const centre = [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + at(point, axis), 0) / 3);
  const spread = Math.max(...points.flatMap((p, i) => points.slice(i + 1).map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))));
  if (!(spread > 0)) return null;
  const relative = points.map(
    (p): Vec3 => [(p[0] - at(centre, 0)) / spread, (p[1] - at(centre, 1)) / spread, (p[2] - at(centre, 2)) / spread],
  );
  const row = (pointIndex: number, axis: number): number[] => [...axisOf(axis), ...cross(relative[pointIndex] ?? [0, 0, 0], axisOf(axis))];
  let best: SupportPattern | null = null;
  for (let free2 = 0; free2 < 3; free2++)
    for (let held3 = 0; held3 < 3; held3++) {
      const two = [0, 1, 2].filter((axis) => axis !== free2);
      const conditioning = smallestPivot([row(0, 0), row(0, 1), row(0, 2), ...two.map((axis) => row(1, axis)), row(2, held3)]);
      if (best === null || conditioning > best.conditioning)
        best = { dofs: [AXES, two.map((axis) => AXES[axis] ?? 'ux'), [AXES[held3] ?? 'ux']], conditioning };
    }
  return best !== null && best.conditioning >= MIN_SUPPORT_PIVOT ? best : null;
}
