/**
 * The linear algebra under the exact G1 solve (`g1Exact.ts`): the conditions A x = b of a group of quads as sparse rows over its unknown poles (the same A for x, y and z),
 * solved for the poles nearest to a start / a limit-surface objective. Two paths with a stated work budget each: dense orthogonalisation with the limit-surface objective for
 * groups up to `DENSE_MAX_UNKNOWNS` unknowns, conjugate gradients on the sparse rows (O(nonzeros) an iteration, no matrix) beyond; a system that does not fit its budget is
 * reported as such, never solved partially.
 * @invariant pure; the work of a call is bounded (`DENSE_MAX_WORK` multiply-adds dense, `SPARSE_MAX_WORK` sparse); `residual` is the largest violation of any row
 */

import type { Vec3 } from '../../model/types';

/** A condition: coefficient x unknown pairs over the local unknowns of a group. */
export type SparseRow = ReadonlyArray<readonly [number, number]>;

/** A sample of the limit-surface objective: sum of weight x unknown + constant - target (per axis). */
export interface Sample {
  readonly terms: Array<readonly [number, number]>;
  readonly constant: Vec3;
  readonly target: Vec3;
}

export interface Solution {
  readonly x: Vec3[];
  readonly residual: number;
  /** "ok", or "budget" when the system needs more work than its path allows (the start poles come back, the residual is infinite). */
  readonly status: 'ok' | 'budget';
  /** What the freedom left by the rows was spent on: "limit" (nearest to the limit surface at the samples), "start" (nearest to the start poles: no samples, or no work left for them). */
  readonly objective: 'limit' | 'start';
  /** Sparse path with samples: the CGLS iterations per projection that ran (0 or absent: none ran; with objective "start" and a value: the projection was too rough and the acceptance gate refused it). */
  readonly projectionIterations?: number;
}

/** Groups up to this many unknown poles are solved by dense orthogonalisation (with the limit-surface objective); larger ones by conjugate gradients. */
export const DENSE_MAX_UNKNOWNS = 900;
/** Multiply-adds of the dense path (Gram-Schmidt twice: 2 rows^2 x unknowns) and of the sparse path (nonzeros x iterations x 2 products x 3 axes); `maxWork` is an approximate bound (it counts the products over the nonzeros, not the vector bookkeeping). */
const DENSE_MAX_WORK = 2.5e9;
const SPARSE_MAX_WORK = 1.5e9;
/** Iterations of the projected conjugate gradient of the objective, and its ridge (relative to a sample weight of 1). */
const OBJECTIVE_ITERATIONS = 80;
const RIDGE = 1e-8;

const dot = (p: ArrayLike<number>, q: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < p.length; i++) sum += (p[i] as number) * (q[i] as number);
  return sum;
};

/** Solves a small dense system by Gaussian elimination with partial pivoting; null when singular. */
export function gaussSolve(m: number[][], r: number[]): number[] | null {
  const n = r.length;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let i = c + 1; i < n; i++)
      if (Math.abs((m[i] as number[])[c] as number) > Math.abs((m[pivot] as number[])[c] as number)) pivot = i;
    if (Math.abs((m[pivot] as number[])[c] as number) < 1e-300) return null;
    [m[c], m[pivot]] = [m[pivot] as number[], m[c] as number[]];
    [r[c], r[pivot]] = [r[pivot] as number, r[c] as number];
    for (let i = c + 1; i < n; i++) {
      const factor = ((m[i] as number[])[c] as number) / ((m[c] as number[])[c] as number);
      for (let k = c; k < n; k++) (m[i] as number[])[k] = ((m[i] as number[])[k] as number) - factor * ((m[c] as number[])[k] as number);
      r[i] = (r[i] as number) - factor * (r[c] as number);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = r[i] as number;
    for (let k = i + 1; k < n; k++) sum -= ((m[i] as number[])[k] as number) * (x[k] as number);
    x[i] = sum / ((m[i] as number[])[i] as number);
  }
  return x;
}

const rowDot = (row: SparseRow, x: ArrayLike<number>): number => {
  let sum = 0;
  for (const [k, c] of row) sum += c * (x[k] as number);
  return sum;
};

/** Largest violation of any row of A x = b for the per-axis solutions `columns`. */
function violation(rows: readonly SparseRow[], b: readonly Vec3[], columns: ReadonlyArray<ArrayLike<number>>): number {
  let residual = 0;
  rows.forEach((row, i) => {
    for (let axis = 0; axis < 3; axis++)
      residual = Math.max(residual, Math.abs(rowDot(row, columns[axis] as ArrayLike<number>) - ((b[i] as Vec3)[axis] as number)));
  });
  return residual;
}

const asPoints = (columns: ReadonlyArray<ArrayLike<number>>, count: number): Vec3[] =>
  Array.from(
    { length: count },
    (_, k): Vec3 => [
      (columns[0] as ArrayLike<number>)[k] as number,
      (columns[1] as ArrayLike<number>)[k] as number,
      (columns[2] as ArrayLike<number>)[k] as number,
    ],
  );

const refused = (start: Vec3[], objective: Solution['objective'] = 'limit'): Solution => ({
  x: start,
  residual: Infinity,
  status: 'budget',
  objective,
});

/**
 * The poles nearest to the objective with A x = b by dense orthogonalisation: independent rows by Gram-Schmidt (twice) with the triangular factor kept, A_k = L Q, so the
 * particular solution is x0 + Q^T L^-1 r (no squared conditioning); a row with nothing new in it (below 1e-6 of its own norm or 1e-8 of the largest row) is not a condition. With
 * `samples` the remaining freedom (the null space of A) minimises the squared distance of the surface to the limit surface at the samples (projected conjugate gradient).
 */
export function solveDense(
  rows: readonly SparseRow[],
  b: readonly Vec3[],
  start: Vec3[],
  samples: readonly Sample[],
  maxWork = DENSE_MAX_WORK,
): Solution {
  const n = start.length;
  if (2 * rows.length * rows.length * n > maxWork) return refused(start);
  const dense = rows.map((row) => {
    const line = new Float64Array(n);
    for (const [k, c] of row) line[k] = (line[k] as number) + c;
    return line;
  });
  const largest = Math.max(...dense.map((row) => Math.sqrt(dot(row, row))), 1e-300);
  const basis: Float64Array[] = [];
  const factor: Float64Array[] = [];
  const kept: number[] = [];
  dense.forEach((row, i) => {
    const w = Float64Array.from(row);
    const coefficients = new Float64Array(basis.length + 1);
    for (let pass = 0; pass < 2; pass++)
      basis.forEach((q, j) => {
        const c = dot(w, q);
        coefficients[j] = (coefficients[j] as number) + c;
        for (let k = 0; k < n; k++) w[k] = (w[k] as number) - c * (q[k] as number);
      });
    const length = Math.sqrt(dot(w, w));
    // independent: a real part of the row is left after the kept ones, relative to the row and to the largest row (noise rows, 1e-16 of the others, are not conditions)
    if (length > 1e-6 * Math.max(Math.sqrt(dot(row, row)), 1e-300) && length > 1e-8 * largest) {
      coefficients[basis.length] = length;
      basis.push(w.map((v) => v / length));
      factor.push(coefficients);
      kept.push(i);
    }
  });
  const project = (v: Float64Array): Float64Array => {
    const out = Float64Array.from(v);
    for (let pass = 0; pass < 2; pass++)
      basis.forEach((q) => {
        const c = dot(out, q);
        for (let k = 0; k < n; k++) out[k] = (out[k] as number) - c * (q[k] as number);
      });
    return out;
  };
  const columns: Float64Array[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const current = Float64Array.from(start, (p) => p[axis] as number);
    const y = new Float64Array(kept.length);
    factor.forEach((line, i) => {
      let sum = ((b[kept[i] as number] as Vec3)[axis] as number) - rowDot(rows[kept[i] as number] as SparseRow, current);
      for (let j = 0; j < i; j++) sum -= (line[j] as number) * (y[j] as number);
      y[i] = sum / (line[i] as number);
    });
    const x = Float64Array.from(current);
    basis.forEach((q, j) => {
      for (let k = 0; k < n; k++) x[k] = (x[k] as number) + (q[k] as number) * (y[j] as number);
    });
    // the freedom left: nearest to the limit surface at the samples
    if (samples.length > 0 && basis.length < n) {
      const t = samples.map((s) => (s.target[axis] as number) - (s.constant[axis] as number));
      const applyW = (v: Float64Array): Float64Array => Float64Array.from(samples, (s) => rowDot(s.terms, v));
      const applyWT = (r: Float64Array): Float64Array => {
        const out = new Float64Array(n);
        samples.forEach((s, i) => s.terms.forEach(([u, w]) => (out[u] = (out[u] as number) + w * (r[i] as number))));
        return out;
      };
      const wx = applyW(x);
      let r = project(applyWT(Float64Array.from(wx, (v, i) => v - (t[i] as number)))).map((v) => -v);
      let p = Float64Array.from(r);
      let old = dot(r, r);
      const stop = 1e-24 * Math.max(old, 1e-300);
      for (let it = 0; it < OBJECTIVE_ITERATIONS && old > stop; it++) {
        // a small ridge keeps the directions the samples do not see from running away
        const ap = project(applyWT(applyW(p))).map((v, k) => v + RIDGE * (p[k] as number));
        const curvature = dot(p, ap);
        if (!(curvature > 1e-300)) break;
        const alpha = old / curvature;
        for (let k = 0; k < n; k++) x[k] = (x[k] as number) + alpha * (p[k] as number);
        r = r.map((v, k) => v - alpha * (ap[k] as number));
        const fresh = dot(r, r);
        p = r.map((v, k) => v + (fresh / old) * (p[k] as number));
        old = fresh;
      }
    }
    columns.push(x);
  }
  return {
    x: asPoints(columns, n),
    residual: violation(rows, b, columns),
    status: 'ok',
    objective: samples.length > 0 ? 'limit' : 'start',
  };
}

/** Outer iterations of the projected conjugate gradient of the sparse objective. */
const SPARSE_OBJECTIVE_ITERATIONS = 30;
/** Fewest inner CGLS iterations per projection worth running (below it the projection is too rough: the objective is skipped). */
const MIN_INNER_ITERATIONS = 20;
const MAX_INNER_ITERATIONS = 400;
/** Projections per axis: one for the first residual, one per outer iteration. */
const PROJECTIONS = SPARSE_OBJECTIVE_ITERATIONS + 1;
/** Rounds of the repair (each at most 4 x inner CGLS iterations). */
const REPAIR_ROUNDS = 3;

/**
 * Conjugate gradients on the normal equations (CGLS) from `start` over the sparse rows: the nearest solution when the system is consistent, the least-squares one otherwise.
 * No matrix is built; the iteration count is capped by the work budget, and a system that has not converged by then is `budget`.
 * With `samples` the freedom the rows leave is then spent on the distance to the limit surface at the samples, like the dense path: projected conjugate gradient whose projector
 * P = I - A^T (A A^T)^+ A is applied through the sparse rows (the product A^+ A v by CGLS on the rows, no matrix), inside what is left of the work budget; a budget too small for a
 * projection of at least MIN_INNER_ITERATIONS iterations keeps the nearest-to-start solution (`objective: "start"`).
 */
export function solveSparse(
  rows: readonly SparseRow[],
  b: readonly Vec3[],
  start: Vec3[],
  samples: readonly Sample[] = [],
  maxWork = SPARSE_MAX_WORK,
): Solution {
  const n = start.length;
  const nonzeros = rows.reduce((sum, row) => sum + row.length, 0);
  const iterations = Math.min(6 * n, Math.floor(maxWork / Math.max(1, 12 * nonzeros)));
  let feasibilityIterations = 0;
  const columns: Float64Array[] = [];
  let capped = false;
  for (let axis = 0; axis < 3; axis++) {
    const x = Float64Array.from(start, (p) => p[axis] as number);
    const applyT = (r: Float64Array): Float64Array => {
      const out = new Float64Array(n);
      rows.forEach((row, i) => {
        const ri = r[i] as number;
        if (ri !== 0) for (const [k, c] of row) out[k] = (out[k] as number) + c * ri;
      });
      return out;
    };
    let r = Float64Array.from(rows, (row, i) => ((b[i] as Vec3)[axis] as number) - rowDot(row, x));
    let s = applyT(r);
    let p = Float64Array.from(s);
    let gamma = dot(s, s);
    const stop = 1e-30 * Math.max(gamma, 1e-300);
    let it = 0;
    for (; it < iterations && gamma > stop; it++) {
      feasibilityIterations++;
      const q = Float64Array.from(rows, (row) => rowDot(row, p));
      const denominator = dot(q, q);
      if (!(denominator > 1e-300)) break;
      const alpha = gamma / denominator;
      for (let k = 0; k < n; k++) x[k] = (x[k] as number) + alpha * (p[k] as number);
      r = r.map((v, i) => v - alpha * (q[i] as number));
      s = applyT(r);
      const fresh = dot(s, s);
      p = s.map((v, k) => v + (fresh / gamma) * (p[k] as number));
      gamma = fresh;
    }
    if (it >= iterations && gamma > stop && iterations < 6 * n) capped = true;
    columns.push(x);
  }
  const solution: Solution = {
    x: asPoints(columns, n),
    residual: violation(rows, b, columns),
    status: capped ? 'budget' : 'ok',
    objective: 'start',
  };
  if (capped || samples.length === 0) return solution;
  const sampleNonzeros = samples.reduce((sum, sample) => sum + sample.terms.length, 0);
  // work left after the feasibility iterations (12 nonzeros each), per axis: PROJECTIONS projections (each `inner` CGLS iterations of 4 nonzeros, plus 2 products over the rows and 4 over the samples)
  // and the repair (REPAIR_ROUNDS rounds of 4 x inner iterations of 4 nonzeros); maxWork is approximate (the counts are of multiply-adds by nonzeros, not of the vector bookkeeping)
  const left = maxWork - feasibilityIterations * 12 * nonzeros;
  const perAxis = left / 3 - PROJECTIONS * (4 * sampleNonzeros + 2 * nonzeros);
  const inner = Math.min(MAX_INNER_ITERATIONS, Math.floor(perAxis / Math.max(1, (PROJECTIONS * 4 + REPAIR_ROUNDS * 4 * 4) * nonzeros)));
  if (inner < MIN_INNER_ITERATIONS) return solution;
  const improved = columns.map((column, axis) => limitObjective(rows, samples, column, axis, inner));
  const repaired = improved.map((column, axis) => repair(rows, b, column, axis, inner));
  const residual = violation(rows, b, repaired);
  // acceptance gate: a projection too rough to keep the conditions (the repair could not bring x back onto A x = b) keeps the nearest-to-start solution
  return residual < solution.residual * 1e3 + 1e-12
    ? { x: asPoints(repaired, n), residual, status: 'ok', objective: 'limit', projectionIterations: inner }
    : { ...solution, projectionIterations: inner };
}

/** The product A^+ A v by CGLS on the rows from zero (the part of v in the row space of A), `iterations` at most. */
function rowSpacePart(rows: readonly SparseRow[], v: Float64Array, iterations: number): Float64Array {
  const n = v.length;
  const z = new Float64Array(n);
  let r = Float64Array.from(rows, (row) => rowDot(row, v));
  const applyT = (w: Float64Array): Float64Array => {
    const out = new Float64Array(n);
    rows.forEach((row, i) => {
      const wi = w[i] as number;
      if (wi !== 0) for (const [k, c] of row) out[k] = (out[k] as number) + c * wi;
    });
    return out;
  };
  let s = applyT(r);
  let p = Float64Array.from(s);
  let gamma = dot(s, s);
  const stop = 1e-26 * Math.max(gamma, 1e-300);
  for (let it = 0; it < iterations && gamma > stop; it++) {
    const q = Float64Array.from(rows, (row) => rowDot(row, p));
    const denominator = dot(q, q);
    if (!(denominator > 1e-300)) break;
    const alpha = gamma / denominator;
    for (let k = 0; k < n; k++) z[k] = (z[k] as number) + alpha * (p[k] as number);
    r = r.map((value, i) => value - alpha * (q[i] as number));
    s = applyT(r);
    const fresh = dot(s, s);
    p = s.map((value, k) => value + (fresh / gamma) * (p[k] as number));
    gamma = fresh;
  }
  return z;
}

/** x moved inside the null space of the rows (v -> v - A^+ A v) towards the samples of the limit surface: projected conjugate gradient with a small ridge. */
function limitObjective(
  rows: readonly SparseRow[],
  samples: readonly Sample[],
  start: Float64Array,
  axis: number,
  inner: number,
): Float64Array {
  const n = start.length;
  const x = Float64Array.from(start);
  const project = (v: Float64Array): Float64Array => {
    const part = rowSpacePart(rows, v, inner);
    return v.map((value, k) => value - (part[k] as number));
  };
  const t = samples.map((sample) => (sample.target[axis] as number) - (sample.constant[axis] as number));
  const applyW = (v: Float64Array): Float64Array => Float64Array.from(samples, (sample) => rowDot(sample.terms, v));
  const applyWT = (w: Float64Array): Float64Array => {
    const out = new Float64Array(n);
    samples.forEach((sample, i) => sample.terms.forEach(([u, weight]) => (out[u] = (out[u] as number) + weight * (w[i] as number))));
    return out;
  };
  let r = project(applyWT(Float64Array.from(applyW(x), (value, i) => value - (t[i] as number)))).map((value) => -value);
  let p = Float64Array.from(r);
  let old = dot(r, r);
  const stop = 1e-24 * Math.max(old, 1e-300);
  for (let it = 0; it < SPARSE_OBJECTIVE_ITERATIONS && old > stop; it++) {
    const ap = project(applyWT(applyW(p))).map((value, k) => value + RIDGE * (p[k] as number));
    const curvature = dot(p, ap);
    if (!(curvature > 1e-300)) break;
    const alpha = old / curvature;
    for (let k = 0; k < n; k++) x[k] = (x[k] as number) + alpha * (p[k] as number);
    r = r.map((value, k) => value - alpha * (ap[k] as number));
    const fresh = dot(r, r);
    p = r.map((value, k) => value + (fresh / old) * (p[k] as number));
    old = fresh;
  }
  return x;
}

/** x corrected back onto A x = b (the inexact projections drift off it by rounding of the inner solves): x + A^+ (b - A x). */
function repair(rows: readonly SparseRow[], b: readonly Vec3[], x: Float64Array, axis: number, inner: number): Float64Array {
  const n = x.length;
  let current = x;
  for (let round = 0; round < REPAIR_ROUNDS; round++) {
    const residual = Float64Array.from(rows, (row, i) => ((b[i] as Vec3)[axis] as number) - rowDot(row, current));
    if (Math.sqrt(dot(residual, residual)) < 1e-14) break;
    // A^+ residual by CGLS on the rows
    const z = new Float64Array(n);
    let r = Float64Array.from(residual);
    const applyT = (w: Float64Array): Float64Array => {
      const out = new Float64Array(n);
      rows.forEach((row, i) => {
        const wi = w[i] as number;
        if (wi !== 0) for (const [k, c] of row) out[k] = (out[k] as number) + c * wi;
      });
      return out;
    };
    let s = applyT(r);
    let p = Float64Array.from(s);
    let gamma = dot(s, s);
    const stop = 1e-30 * Math.max(gamma, 1e-300);
    for (let it = 0; it < 4 * inner && gamma > stop; it++) {
      const q = Float64Array.from(rows, (row) => rowDot(row, p));
      const denominator = dot(q, q);
      if (!(denominator > 1e-300)) break;
      const alpha = gamma / denominator;
      for (let k = 0; k < n; k++) z[k] = (z[k] as number) + alpha * (p[k] as number);
      r = r.map((value, i) => value - alpha * (q[i] as number));
      s = applyT(r);
      const fresh = dot(s, s);
      p = s.map((value, k) => value + (fresh / gamma) * (p[k] as number));
      gamma = fresh;
    }
    current = current.map((value, k) => value + (z[k] as number));
  }
  return current;
}
