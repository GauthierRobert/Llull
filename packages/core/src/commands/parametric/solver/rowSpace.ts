import type { SparseRow } from './problem';
import { addAt, at } from './linalg';

export interface RowSpace {
  readonly rank: number;
  /** Squared length of the row space's projection on each variable: 1 when the rows fix the variable, 0 when it is free. */
  readonly determined: Float64Array;
}

const RELATIVE_TOLERANCE = 1e-6;
const COEFFICIENT_TOLERANCE = 1e-6;

const norm = (row: SparseRow): number => Math.sqrt(row.val.reduce((sum, value) => sum + value * value, 0));

/**
 * Rank-revealing modified Gram–Schmidt (one re-orthogonalisation) over `n`-column rows in the given order: a row whose remainder after
 * projection on the earlier rows is below `1e-6` of its own length adds nothing. Dense, `rows × n` memory.
 */
export function reduceRows(rows: readonly SparseRow[], n: number): RowSpace {
  const basis = new Float64Array(rows.length * n);
  const first = new Int32Array(rows.length);
  const last = new Int32Array(rows.length);
  let rank = 0;
  const work = new Float64Array(n);
  for (const row of rows) {
    work.fill(0);
    row.idx.forEach((column, k) => {
      work[column] = at(row.val, k);
    });
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < rank; j++) {
        const base = j * n;
        const from = first[j] as number;
        const to = last[j] as number;
        let projection = 0;
        for (let c = from; c <= to; c++) projection += (basis[base + c] as number) * (work[c] as number);
        if (projection === 0) continue;
        for (let c = from; c <= to; c++) addAt(work, c, -(projection * (basis[base + c] as number)));
      }
    }
    let remainder = 0;
    let lo = n;
    let hi = -1;
    for (let c = 0; c < n; c++) {
      const value = work[c] as number;
      if (Math.abs(value) > 1e-15) {
        remainder += value * value;
        if (c < lo) lo = c;
        hi = c;
      }
    }
    remainder = Math.sqrt(remainder);
    if (remainder > 1e-12 && remainder > RELATIVE_TOLERANCE * norm(row)) {
      for (let c = lo; c <= hi; c++) basis[rank * n + c] = (work[c] as number) / remainder;
      first[rank] = lo;
      last[rank] = hi;
      rank++;
    }
  }
  const determined = new Float64Array(n);
  for (let j = 0; j < rank; j++)
    for (let c = first[j] as number; c <= (last[j] as number); c++) addAt(determined, c, (basis[j * n + c] as number) ** 2);
  return { rank, determined };
}

/**
 * Whether each of `focus` (row indices) is a linear combination of the other rows (and of the focus rows before it), and which other
 * rows it uses. Least squares by conjugate gradients on the normal equations: sparse products only, so a constraint in a long chain
 * costs time proportional to the chain, not its square. A focus row that is the only one touching some variable is independent at once.
 */
export function dependencyOnOthers(rows: readonly SparseRow[], focus: readonly number[], n: number): { redundant: boolean; on: number[] } {
  const focusSet = new Set(focus);
  const columns = rows.map((_, index) => index).filter((index) => !focusSet.has(index));
  const touching = new Int32Array(n);
  for (const index of columns) for (const column of rows[index]?.idx ?? []) touching[column] = (touching[column] as number) + 1;
  const used = new Set<number>();
  let redundant = false;
  for (const target of focus) {
    const b = rows[target] ?? { idx: [], val: [] };
    const size = norm(b);
    const independentAtOnce = size >= 1e-12 && b.idx.some((column, p) => touching[column] === 0 && Math.abs(at(b.val, p)) > 1e-9 * size);
    if (!independentAtOnce) {
      const k = columns.length;
      const solution = new Float64Array(k);
      const residual = new Float64Array(n);
      b.idx.forEach((column, p) => (residual[column] = at(b.val, p)));
      const s = new Float64Array(k);
      const direction = new Float64Array(k);
      const product = new Float64Array(n);
      const project = (vector: Float64Array, out: Float64Array): void => {
        for (let c = 0; c < k; c++) {
          const row = rows[columns[c] as number] as SparseRow;
          let sum = 0;
          for (let q = 0; q < row.idx.length; q++) sum += (row.val[q] as number) * (vector[row.idx[q] as number] as number);
          out[c] = sum;
        }
      };
      project(residual, s);
      direction.set(s);
      let gamma = 0;
      for (let c = 0; c < k; c++) gamma += (s[c] as number) ** 2;
      const gamma0 = gamma;
      for (let iteration = 0; iteration < 4 * k + 20 && gamma > 1e-30 * gamma0 && gamma > 0; iteration++) {
        product.fill(0);
        for (let c = 0; c < k; c++) {
          const weight = direction[c] as number;
          if (weight === 0) continue;
          const row = rows[columns[c] as number] as SparseRow;
          for (let q = 0; q < row.idx.length; q++) addAt(product, row.idx[q] as number, weight * (row.val[q] as number));
        }
        let qq = 0;
        for (let c = 0; c < n; c++) qq += (product[c] as number) ** 2;
        if (qq === 0) break;
        const alpha = gamma / qq;
        for (let c = 0; c < k; c++) addAt(solution, c, alpha * (direction[c] as number));
        for (let c = 0; c < n; c++) addAt(residual, c, -(alpha * (product[c] as number)));
        project(residual, s);
        let next = 0;
        for (let c = 0; c < k; c++) next += (s[c] as number) ** 2;
        const beta = next / gamma;
        for (let c = 0; c < k; c++) direction[c] = (s[c] as number) + beta * (direction[c] as number);
        gamma = next;
      }
      let remainder = 0;
      for (let c = 0; c < n; c++) remainder += (residual[c] as number) ** 2;
      if (size < 1e-12 || Math.sqrt(remainder) <= RELATIVE_TOLERANCE * size) {
        redundant = true;
        columns.forEach((rowIndex, c) => {
          if (Math.abs(solution[c] as number) > COEFFICIENT_TOLERANCE) used.add(rowIndex);
        });
      }
    }
    columns.push(target);
    for (const column of b.idx) touching[column] = (touching[column] as number) + 1;
  }
  return { redundant, on: [...used] };
}
