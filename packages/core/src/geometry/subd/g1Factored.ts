/**
 * Direct projector for the sparse G1 solve (`g1Linear.ts`, DES-4c): the normal matrix M = A A^T of the condition rows, ordered by reverse Cuthill-McKee, factored once by an envelope (skyline)
 * LDL^T whose dependent rows (a pivot that cancelled to nothing) are dropped like the dense path drops them; then P v = v - A^T M^-1 A v and A^+ r = A^T M^-1 r are two triangular sweeps
 * (with one step of iterative refinement), so every projection of the limit-surface objective costs the envelope, not hundreds of conjugate-gradient iterations.
 * @invariant pure; deterministic (fixed ordering, fixed loop order: bit-stable); `flops` is known before any numeric work and a factorisation over the caller's budget is not built
 */

import { maxOf } from '../../lib/arrayExtrema';
import { minimumDegree } from './g1Ordering';
import { factorNumeric, symbolicFill } from './g1SparseLdl';

/** A condition: coefficient x unknown pairs (the same shape as `SparseRow` of `g1Linear.ts`, which imports this file). */
type SparseRow = ReadonlyArray<readonly [number, number]>;

/** The envelope of M above this many entries (8 bytes each) is not built: the caller keeps the iterative path. */
const MAX_ENVELOPE = 4e7;
/** A pivot that cancelled to this fraction of its own diagonal (1e-6 of the row norm, squared) is a dependent row; a row below 1e-8 of the largest norm (squared) is no condition. */
const DEPENDENT = 1e-12;
const NEGLIGIBLE = 1e-16;
/** An envelope factor costing no more than this many multiply-adds (factorisation plus its solves) is kept without planning minimum degree. */
const CHEAP_COST = 5e6;

export interface Projector {
  /** Multiply-adds of the factorisation (known from the ordering alone). */
  readonly flops: number;
  /** Multiply-adds of one projection `project` (two sweeps over the envelope for the solve and its refinement, plus the row products). */
  readonly perProjection: number;
  /** v - A^T M^-1 A v: the part of v in the null space of the rows. */
  readonly project: (v: Float64Array) => Float64Array;
  /** A^T M^-1 r: the shortest step that changes the rows by r (r in the range of A). */
  readonly pseudoInverse: (r: Float64Array) => Float64Array;
}

/** Rows with their repeated unknowns summed and sorted by unknown (so every sum below has one fixed order). */
function merged(rows: readonly SparseRow[]): Array<Array<readonly [number, number]>> {
  return rows.map((row) => {
    const sorted = [...row].sort((p, q) => p[0] - q[0]);
    const out: Array<readonly [number, number]> = [];
    for (const [k, c] of sorted) {
      const last = out[out.length - 1];
      if (last !== undefined && last[0] === k) out[out.length - 1] = [k, last[1] + c];
      else out.push([k, c]);
    }
    return out;
  });
}

/** Adjacency (sorted, no self) of the rows that share an unknown. */
function adjacency(rows: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, unknowns: number): number[][] {
  const touching: number[][] = Array.from({ length: unknowns }, () => []);
  rows.forEach((row, i) => row.forEach(([k]) => (touching[k] as number[]).push(i)));
  const sets: Array<Set<number>> = rows.map(() => new Set<number>());
  for (const list of touching) for (const a of list) for (const b of list) if (a !== b) (sets[a] as Set<number>).add(b);
  return sets.map((set) => [...set].sort((p, q) => p - q));
}

/** Reverse Cuthill-McKee order (each component from a pseudo-peripheral node; ties by degree, then index): `order[position] = row`. */
function reverseCuthillMcKee(graph: readonly number[][]): number[] {
  const count = graph.length;
  const degree = (v: number): number => (graph[v] as number[]).length;
  const seen = new Uint8Array(count);
  const levelsFrom = (root: number, stamp: Uint8Array): number[][] => {
    const levels: number[][] = [[root]];
    stamp[root] = 1;
    for (;;) {
      const next: number[] = [];
      for (const v of levels[levels.length - 1] as number[])
        for (const w of graph[v] as number[])
          if (!stamp[w]) {
            stamp[w] = 1;
            next.push(w);
          }
      if (next.length === 0) return levels;
      levels.push(next);
    }
  };
  const order: number[] = [];
  for (let first = 0; first < count; first++) {
    if (seen[first]) continue;
    // the component of `first`, then a pseudo-peripheral root of it: the lowest-degree node of the last level, repeated while the depth grows
    let root = first;
    let depth = levelsFrom(root, new Uint8Array(count)).length;
    for (let round = 0; round < 4; round++) {
      const levels = levelsFrom(root, new Uint8Array(count));
      const last = levels[levels.length - 1] as number[];
      const candidate = last.reduce(
        (best, v) => (degree(v) < degree(best) || (degree(v) === degree(best) && v < best) ? v : best),
        last[0] as number,
      );
      const deeper = levelsFrom(candidate, new Uint8Array(count)).length;
      if (deeper <= depth) break;
      [root, depth] = [candidate, deeper];
    }
    const queue = [root];
    seen[root] = 1;
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head] as number;
      order.push(v);
      const fresh = (graph[v] as number[]).filter((w) => !seen[w]).sort((p, q) => degree(p) - degree(q) || p - q);
      for (const w of fresh) {
        seen[w] = 1;
        queue.push(w);
      }
    }
  }
  return order.reverse();
}

export interface FactorOptions {
  /** "auto": the cheaper of the reverse Cuthill-McKee envelope and the minimum-degree sparse factor that fit; the others force one ordering. */
  readonly ordering?: 'auto' | 'rcm' | 'minimum-degree';
  /** Envelope entries above which RCM is not built (default 4e7). */
  readonly envelopeLimit?: number;
  /** Entries of L above which minimum degree is not built (default 4e7). */
  readonly fillLimit?: number;
}

type Rows = ReadonlyArray<ReadonlyArray<readonly [number, number]>>;

/** A solver of M z = r (r and z indexed by row). */
type Normal = (r: Float64Array) => Float64Array;

/** An ordering's factor before any numeric work: its stored entries and costs are known; `build` factors. */
interface Plan {
  readonly entries: number;
  readonly flops: number;
  readonly perSolve: number;
  readonly build: () => Normal;
}

/** A pivot that cancelled (to DEPENDENT of its own diagonal) or a row far below the largest diagonal is a dependent row. */
export const isDependent = (pivot: number, diagonal: number, diagonalMax: number): boolean =>
  !(pivot > DEPENDENT * diagonal) || diagonal < NEGLIGIBLE * diagonalMax;

/** For each unknown the (permuted row, coefficient) pairs of the rows that use it, in row order. */
function touchingLists(merge: Rows, unknowns: number, position: Int32Array): Array<Array<readonly [number, number]>> {
  const touching: Array<Array<readonly [number, number]>> = Array.from({ length: unknowns }, () => []);
  merge.forEach((row, i) => row.forEach(([k, c]) => (touching[k] as Array<readonly [number, number]>).push([position[i] as number, c])));
  return touching;
}

const positionsOf = (order: readonly number[]): Int32Array => {
  const position = new Int32Array(order.length);
  order.forEach((row, p) => (position[row] = p));
  return position;
};

/** The envelope (skyline) LDL^T in reverse Cuthill-McKee order. */
function envelopePlan(merge: Rows, unknowns: number, graph: readonly number[][]): Plan {
  const count = merge.length;
  const order = reverseCuthillMcKee(graph);
  const position = positionsOf(order);
  // envelope: row p stores the columns first[p]..p
  const first = new Int32Array(count);
  const offset = new Float64Array(count + 1);
  let flops = 0;
  for (let p = 0; p < count; p++) {
    let low = p;
    for (const w of graph[order[p] as number] as number[]) low = Math.min(low, position[w] as number);
    first[p] = low;
    const width = p - low;
    offset[p + 1] = (offset[p] as number) + width + 1;
    flops += width * width;
  }
  const size = offset[count] as number;
  const nonzeros = merge.reduce((sum, row) => sum + row.length, 0);
  const perSolve = 4 * size + 2 * nonzeros;
  const build = (): Normal => {
    // M = A A^T into the envelope
    const entries = new Float64Array(size);
    for (const list of touchingLists(merge, unknowns, position))
      for (const [a, ca] of list)
        for (const [b, cb] of list) {
          const at = (offset[a] as number) + b - (first[a] as number);
          if (b <= a) entries[at] = (entries[at] as number) + ca * cb;
        }
    // LDL^T by rows: L unit lower triangular in place (the diagonal slot holds D), a dropped row has D = 0 and an empty L row
    const diagonalMax = Math.max(
      maxOf(Array.from({ length: count }, (_, p) => entries[(offset[p] as number) + p - (first[p] as number)] as number)),
      1e-300,
    );

    const y = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const [fi, oi] = [first[i] as number, offset[i] as number];
      const diagonal = entries[oi + i - fi] as number;
      let pivot = diagonal;
      for (let j = fi; j < i; j++) {
        const [fj, oj] = [first[j] as number, offset[j] as number];
        let sum = entries[oi + j - fi] as number;
        for (let k = Math.max(fi, fj); k < j; k++) sum -= (y[k] as number) * (entries[oj + k - fj] as number);
        y[j] = sum;
        const d = entries[oj + j - fj] as number;
        const l = d > 0 ? sum / d : 0;
        entries[oi + j - fi] = l;
        pivot -= l * sum;
      }
      if (isDependent(pivot, diagonal, diagonalMax)) {
        for (let j = fi; j < i; j++) entries[oi + j - fi] = 0;
        entries[oi + i - fi] = 0;
      } else entries[oi + i - fi] = pivot;
    }
    const normal = (r: Float64Array): Float64Array => {
      // M^-1 r through the factor, r and the result indexed by row
      const z = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        const [fi, oi] = [first[i] as number, offset[i] as number];
        let sum = r[order[i] as number] as number;
        for (let j = fi; j < i; j++) sum -= (entries[oi + j - fi] as number) * (z[j] as number);
        z[i] = sum;
      }
      for (let i = 0; i < count; i++) {
        const d = entries[(offset[i] as number) + i - (first[i] as number)] as number;
        z[i] = d > 0 ? (z[i] as number) / d : 0;
      }
      for (let i = count - 1; i >= 0; i--) {
        const [fi, oi] = [first[i] as number, offset[i] as number];
        const zi = z[i] as number;
        if (zi !== 0) for (let j = fi; j < i; j++) z[j] = (z[j] as number) - (entries[oi + j - fi] as number) * zi;
      }
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[order[i] as number] = z[i] as number;
      return out;
    };
    return normal;
  };
  return { entries: size, flops, perSolve, build };
}

/** The sparse LDL^T in approximate-minimum-degree order. */
function minimumDegreePlan(merge: Rows, unknowns: number, graph: readonly number[][]): Plan {
  const count = merge.length;
  const order = minimumDegree(graph);
  const position = positionsOf(order);
  const upper = order.map((row, p) => (graph[row] as number[]).map((w) => position[w] as number).filter((w) => w < p));
  const symbolic = symbolicFill(upper);
  const nonzeros = merge.reduce((sum, row) => sum + row.length, 0);
  const perSolve = 4 * (symbolic.fill + count) + 2 * nonzeros;
  const build = (): Normal => {
    // column k of M = A A^T in the permuted order, rows <= k: accumulated in a dense work vector through the unknowns of row k
    const touching = touchingLists(merge, unknowns, position);
    const work = new Float64Array(count);
    const diagonalMax = Math.max(maxOf(merge.map((row) => row.reduce((sum, [, c]) => sum + c * c, 0))), 1e-300);
    const column = (k: number): readonly [readonly number[], readonly number[]] => {
      const own = merge[order[k] as number] as ReadonlyArray<readonly [number, number]>;
      for (const [u, cu] of own)
        for (const [a, ca] of touching[u] as Array<readonly [number, number]>) work[a] = (work[a] as number) + cu * ca;
      const rows = [...(upper[k] as number[]), k];
      const values = rows.map((a) => work[a] as number);
      for (const [u] of own) for (const [a] of touching[u] as Array<readonly [number, number]>) work[a] = 0;
      return [rows, values];
    };
    const solve = factorNumeric(symbolic, column, (pivot, diagonal) => isDependent(pivot, diagonal, diagonalMax));
    const normal = (r: Float64Array): Float64Array => {
      const z = solve(Float64Array.from(order, (row) => r[row] as number));
      const out = new Float64Array(count);
      for (let p = 0; p < count; p++) out[order[p] as number] = z[p] as number;
      return out;
    };
    return normal;
  };
  return { entries: symbolic.fill + count, flops: symbolic.flops, perSolve, build };
}

/**
 * The factored projector of the rows over `unknowns` unknowns, or null when it does not fit: no ordering within its entry limit (an envelope in reverse Cuthill-McKee order, or minimum
 * degree; the cheaper of those that fit is built), or a factorisation (plus `projections` projections and `pseudoInverses` pseudo-inverse solves per axis, three axes) over `maxWork`
 * multiply-adds.
 */
export function factorRows(
  rows: readonly SparseRow[],
  unknowns: number,
  maxWork: number,
  projections: number,
  pseudoInverses: number,
  options: FactorOptions = {},
): Projector | null {
  if (rows.length === 0) return null;
  const { ordering = 'auto', envelopeLimit = MAX_ENVELOPE, fillLimit = MAX_ENVELOPE } = options;
  const merge = merged(rows);
  const graph = adjacency(merge, unknowns);
  const fits = (flops: number, perSolve: number): boolean => flops + 3 * (projections + pseudoInverses) * perSolve <= maxWork;
  // the cheaper of the orderings that fit (the envelope on a tie): minimum degree beats the envelope by 100x on the cage rows; it is not planned when the envelope is already cheap
  const cost = (plan: Plan): number => plan.flops + 3 * (projections + pseudoInverses) * plan.perSolve;
  const usable = (plan: Plan, limit: number): boolean => plan.entries <= limit && fits(plan.flops, plan.perSolve);
  const envelope = ordering === 'minimum-degree' ? null : envelopePlan(merge, unknowns, graph);
  const envelopeUsable = envelope !== null && usable(envelope, envelopeLimit);
  const skipMinimumDegree =
    ordering === 'rcm' || (ordering === 'auto' && envelope !== null && envelopeUsable && cost(envelope) <= CHEAP_COST);
  const sparse = skipMinimumDegree ? null : minimumDegreePlan(merge, unknowns, graph);
  const plans = [
    ...(envelope !== null && envelopeUsable ? [envelope] : []),
    ...(sparse !== null && usable(sparse, fillLimit) ? [sparse] : []),
  ];
  const best = plans.reduce<Plan | null>((chosen, plan) => (chosen === null || cost(plan) < cost(chosen) ? plan : chosen), null);
  if (best === null) return null;
  const normal = best.build();
  const times = (v: Float64Array): Float64Array =>
    Float64Array.from(merge, (row) => row.reduce((sum, [k, c]) => sum + c * (v[k] as number), 0));
  const timesTransposed = (w: Float64Array): Float64Array => {
    const out = new Float64Array(unknowns);
    merge.forEach((row, i) => {
      const wi = w[i] as number;
      if (wi !== 0) for (const [k, c] of row) out[k] = (out[k] as number) + c * wi;
    });
    return out;
  };
  // M^-1 r with one step of refinement against M = A A^T applied through the rows
  const refined = (r: Float64Array): Float64Array => {
    const z = normal(r);
    const back = times(timesTransposed(z));
    const correction = normal(Float64Array.from(r, (v, i) => v - (back[i] as number)));
    return z.map((v, i) => v + (correction[i] as number));
  };
  return {
    flops: best.flops,
    perProjection: best.perSolve,
    project: (v) => {
      const part = timesTransposed(refined(times(v)));
      return v.map((value, k) => value - (part[k] as number));
    },
    pseudoInverse: (r) => timesTransposed(refined(r)),
  };
}
