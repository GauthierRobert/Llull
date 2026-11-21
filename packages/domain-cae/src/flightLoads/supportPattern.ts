/** 3-2-1 statically determinate support (14 FLL): which global dofs to hold at three points so exactly the six rigid-body motions are removed. */

import type { Vec3 } from '@core/model/vectors';

type SupportDof = 'ux' | 'uy' | 'uz';
type RestraintRow = readonly [number, number, number, number, number, number];

const UNIT: Readonly<Record<SupportDof, Vec3>> = { ux: [1, 0, 0], uy: [0, 1, 0], uz: [0, 0, 1] };
const ALL: readonly SupportDof[] = ['ux', 'uy', 'uz'];

/** The nine 3-2-1 candidates: point 2 holds two dofs (frees the third), point 3 holds one. */
const PAIRS: readonly (readonly SupportDof[])[] = [
  ['uy', 'uz'],
  ['ux', 'uz'],
  ['ux', 'uy'],
];
const CANDIDATES: readonly { readonly two: readonly SupportDof[]; readonly one: SupportDof }[] = PAIRS.flatMap((two) =>
  ALL.map((one) => ({ two, one })),
);

/** Smallest relative pivot the 6 x 6 restraint matrix may have (about 5 % of the point spread): below it the support is refused as near-singular. */
const MIN_SUPPORT_PIVOT = 0.05;

export interface SupportPattern {
  /** Held dofs at point 1 (all three), point 2 (two), point 3 (one). */
  readonly dofs: readonly [readonly SupportDof[], readonly SupportDof[], readonly SupportDof[]];
  /** Smallest pivot of the rigid-body restraint matrix (1 = perfect, 0 = singular). */
  readonly conditioning: number;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const distance = (p: Vec3, q: Vec3): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/** Row of the restraint matrix for holding `dof` at the scaled relative position `r`: [e, r x e]. */
const restraintRow = (r: Vec3, dof: SupportDof): RestraintRow => [...UNIT[dof], ...cross(r, UNIT[dof])];

/** Smallest pivot magnitude of a square matrix by complete-pivoting elimination (0 when singular). */
function smallestPivot(rows: readonly RestraintRow[]): number {
  const n = rows.length;
  const a = rows.flatMap((row) => [...row]);
  const cell = (index: number): number => a[index] ?? 0;
  const get = (i: number, j: number): number => cell(i * n + j);
  const swap = (p: number, q: number): void => {
    const keep = cell(p);
    a[p] = cell(q);
    a[q] = keep;
  };
  let smallest = Infinity;
  for (let k = 0; k < n; k++) {
    let best = 0;
    let bestRow = k;
    let bestColumn = k;
    for (let i = k; i < n; i++)
      for (let j = k; j < n; j++)
        if (Math.abs(get(i, j)) > best) {
          best = Math.abs(get(i, j));
          bestRow = i;
          bestColumn = j;
        }
    if (best < 1e-300) return 0;
    for (let j = 0; j < n; j++) swap(k * n + j, bestRow * n + j);
    for (let i = 0; i < n; i++) swap(i * n + k, i * n + bestColumn);
    smallest = Math.min(smallest, best);
    for (let i = k + 1; i < n; i++) {
      const factor = get(i, k) / get(k, k);
      for (let j = k; j < n; j++) a[i * n + j] = get(i, j) - factor * get(k, j);
    }
  }
  return smallest;
}

/**
 * The best 3-2-1 pattern of `points` (point 1 holds ux uy uz, point 2 two dofs, point 3 one): a rigid motion t + theta x (p - c) moves a point by
 * u, and holding dof e there is the row [e, (p - c) x e]; the 6 x 6 matrix of the nine candidate patterns is scored by its smallest pivot with
 * lengths scaled by the point spread (the centre c = the mean of the points). Ties keep the first candidate.
 * @invariant the returned pattern has full rank 6 with pivot >= MIN_SUPPORT_PIVOT, else null (collinear, near-collinear, coincident or non-finite points)
 */
export function bestSupportPattern(points: readonly [Vec3, Vec3, Vec3]): SupportPattern | null {
  const [p1, p2, p3] = points;
  const spread = Math.max(distance(p1, p2), distance(p1, p3), distance(p2, p3));
  if (!(spread > 0 && Number.isFinite(spread))) return null;
  const centre: Vec3 = [(p1[0] + p2[0] + p3[0]) / 3, (p1[1] + p2[1] + p3[1]) / 3, (p1[2] + p2[2] + p3[2]) / 3];
  const relative = (p: Vec3): Vec3 => [(p[0] - centre[0]) / spread, (p[1] - centre[1]) / spread, (p[2] - centre[2]) / spread];
  const [r1, r2, r3] = [relative(p1), relative(p2), relative(p3)];
  const first = ALL.map((dof) => restraintRow(r1, dof));
  let best: SupportPattern = { dofs: [ALL, [], []], conditioning: -1 };
  for (const { two, one } of CANDIDATES) {
    const conditioning = smallestPivot([...first, ...two.map((dof) => restraintRow(r2, dof)), restraintRow(r3, one)]);
    if (conditioning > best.conditioning) best = { dofs: [ALL, two, [one]], conditioning };
  }
  return best.conditioning >= MIN_SUPPORT_PIVOT ? best : null;
}
