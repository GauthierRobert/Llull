/** Banded linear solve with partial pivoting (LAPACK `gbsv` layout, O(n · bandwidth²)) for spline collocation systems. */

/** One matrix row as sparse `[column, value]` entries. */
export type SparseRow = ReadonlyArray<readonly [number, number]>;

interface BandRow {
  /** Absolute column of `values[0]`. */
  readonly start: number;
  readonly values: Float64Array;
  rhs: number[];
}

/**
 * Solves A X = B for the square matrix `rows` (row i = A[i][*]) and one right-hand-side vector per row (`rhs[i]`, equal lengths).
 * Returns X as one vector per unknown, or null when the matrix is (numerically) singular.
 * @invariant bandwidth is inferred from the entries; cost is linear in n for a fixed bandwidth
 */
export function solveBanded(rows: ReadonlyArray<SparseRow>, rhs: ReadonlyArray<ReadonlyArray<number>>): number[][] | null {
  const n = rows.length;
  let lower = 0;
  let upper = 0;
  rows.forEach((row, i) =>
    row.forEach(([column]) => {
      lower = Math.max(lower, i - column);
      upper = Math.max(upper, column - i);
    }),
  );
  const width = 2 * lower + upper + 1;
  const matrix: BandRow[] = rows.map((row, i) => {
    const values = new Float64Array(width);
    for (const [column, value] of row) values[column - (i - lower)] = (values[column - (i - lower)] as number) + value;
    return { start: i - lower, values, rhs: [...(rhs[i] as ReadonlyArray<number>)] };
  });
  const entry = (row: BandRow, column: number): number => row.values[column - row.start] as number;
  const reach = lower + upper;
  let scale = 0;
  matrix.forEach((row) => row.values.forEach((value) => (scale = Math.max(scale, Math.abs(value)))));
  for (let k = 0; k < n; k++) {
    let pivot = k;
    const last = Math.min(n - 1, k + lower);
    for (let r = k + 1; r <= last; r++)
      if (Math.abs(entry(matrix[r] as BandRow, k)) > Math.abs(entry(matrix[pivot] as BandRow, k))) pivot = r;
    if (pivot !== k) {
      const swap = matrix[k] as BandRow;
      matrix[k] = matrix[pivot] as BandRow;
      matrix[pivot] = swap;
    }
    const top = matrix[k] as BandRow;
    const diagonal = entry(top, k);
    if (!(Math.abs(diagonal) > 1e-14 * scale)) return null;
    for (let r = k + 1; r <= last; r++) {
      const row = matrix[r] as BandRow;
      const factor = entry(row, k) / diagonal;
      if (factor === 0) continue;
      for (let c = k; c <= Math.min(n - 1, k + reach); c++) row.values[c - row.start] = entry(row, c) - factor * entry(top, c);
      row.rhs = row.rhs.map((value, component) => value - factor * (top.rhs[component] as number));
    }
  }
  const solution: number[][] = new Array<number[]>(n);
  for (let i = n - 1; i >= 0; i--) {
    const row = matrix[i] as BandRow;
    const value = [...row.rhs];
    for (let c = i + 1; c <= Math.min(n - 1, i + reach); c++) {
      const factor = entry(row, c);
      if (factor === 0) continue;
      const known = solution[c] as number[];
      for (let component = 0; component < value.length; component++)
        value[component] = (value[component] as number) - factor * (known[component] as number);
    }
    const diagonal = entry(row, i);
    solution[i] = value.map((component) => component / diagonal);
  }
  return solution;
}
