/**
 * General sparse LDL^T (up-looking, elimination tree; the algorithm of the LDL package) of the normal matrix of the G1 rows in a given order (`g1Factored.ts`, DES-4c): the factor of the
 * orderings whose fill is not an envelope (minimum degree). A row that cancelled to nothing is a dependent row and is dropped (D = 0, its L row and column zero), like the envelope factor.
 * @invariant pure; deterministic (fixed loop order, no hash iteration); `symbolicFill` is known before any numeric work
 */

/** Pattern of the factor: the elimination tree, the column counts and the work, from the strictly upper pattern of the permuted matrix. */
export interface Symbolic {
  readonly parent: Int32Array;
  readonly counts: Int32Array;
  /** Stored entries of L below the diagonal. */
  readonly fill: number;
  /** Multiply-adds of the factorisation (sum of squared column counts). */
  readonly flops: number;
}

/** `upper[k]` = the rows i < k (any order, no repeats) with a structural entry (i, k). */
export function symbolicFill(upper: ReadonlyArray<readonly number[]>): Symbolic {
  const n = upper.length;
  const parent = new Int32Array(n).fill(-1);
  const counts = new Int32Array(n);
  const flag = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    flag[k] = k;
    for (const first of upper[k] as readonly number[])
      for (let i = first; flag[i] !== k; i = parent[i] as number) {
        if (parent[i] === -1) parent[i] = k;
        counts[i] = (counts[i] as number) + 1;
        flag[i] = k;
      }
  }
  let fill = 0;
  let flops = 0;
  for (const count of counts) {
    fill += count;
    flops += count * count;
  }
  return { parent, counts, fill, flops };
}

/** Solves M z = r in the permuted indexing (dropped rows give 0). */
export type SparseSolve = (r: Float64Array) => Float64Array;

/**
 * The numeric factor. `column(k)` = the entries (row i <= k, value) of the permuted matrix column k, the diagonal included, as `[rows, values]`;
 * `isDependent(pivot, diagonal)` decides a dropped row.
 */
export function factorNumeric(
  symbolic: Symbolic,
  column: (k: number) => readonly [readonly number[], readonly number[]],
  isDependent: (pivot: number, diagonal: number) => boolean,
): SparseSolve {
  const { parent, counts } = symbolic;
  const n = parent.length;
  const start = new Int32Array(n + 1);
  for (let j = 0; j < n; j++) start[j + 1] = (start[j] as number) + (counts[j] as number);
  const rowIndex = new Int32Array(start[n] as number);
  const value = new Float64Array(start[n] as number);
  const used = new Int32Array(n);
  const d = new Float64Array(n);
  const y = new Float64Array(n);
  const flag = new Int32Array(n);
  const pattern = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    flag[k] = k;
    let top = n;
    const [rows, values] = column(k);
    let diagonal = 0;
    rows.forEach((row, index) => {
      const v = values[index] as number;
      if (row === k) diagonal = v;
      y[row] = (y[row] as number) + v;
      let length = 0;
      for (let i = row; flag[i] !== k; i = parent[i] as number) {
        pattern[length++] = i;
        flag[i] = k;
      }
      while (length > 0) pattern[--top] = pattern[--length] as number;
    });
    let pivot = y[k] as number;
    y[k] = 0;
    const written: number[] = [];
    for (; top < n; top++) {
      const i = pattern[top] as number;
      const yi = y[i] as number;
      y[i] = 0;
      const end = (start[i] as number) + (used[i] as number);
      for (let p = start[i] as number; p < end; p++)
        y[rowIndex[p] as number] = (y[rowIndex[p] as number] as number) - (value[p] as number) * yi;
      const di = d[i] as number;
      const l = di > 0 ? yi / di : 0;
      pivot -= l * yi;
      rowIndex[end] = k;
      value[end] = l;
      written.push(end);
      used[i] = (used[i] as number) + 1;
    }
    if (isDependent(pivot, diagonal)) {
      for (const at of written) value[at] = 0;
      d[k] = 0;
    } else d[k] = pivot;
  }
  return (r) => {
    const x = Float64Array.from(r);
    for (let j = 0; j < n; j++) {
      const xj = x[j] as number;
      const end = (start[j] as number) + (used[j] as number);
      if (xj !== 0)
        for (let p = start[j] as number; p < end; p++)
          x[rowIndex[p] as number] = (x[rowIndex[p] as number] as number) - (value[p] as number) * xj;
    }
    for (let j = 0; j < n; j++) x[j] = (d[j] as number) > 0 ? (x[j] as number) / (d[j] as number) : 0;
    for (let j = n - 1; j >= 0; j--) {
      let sum = x[j] as number;
      const end = (start[j] as number) + (used[j] as number);
      for (let p = start[j] as number; p < end; p++) sum -= (value[p] as number) * (x[rowIndex[p] as number] as number);
      x[j] = sum;
    }
    return x;
  };
}
