/** Skyline (variable-band) symmetric matrix with in-place Cholesky A = L L^T. Row i stores columns first[i]..i. */
export class Skyline {
  readonly size: number;
  readonly first: Int32Array;
  readonly offset: Int32Array;
  readonly values: Float64Array;

  constructor(first: Int32Array) {
    this.size = first.length;
    this.first = first;
    const offset = new Int32Array(first.length + 1);
    for (let i = 0; i < first.length; i++) offset[i + 1] = (offset[i] as number) + (i - (first[i] as number) + 1);
    this.offset = offset;
    this.values = new Float64Array(offset[first.length] as number);
  }

  get profile(): number {
    return this.values.length;
  }

  get bandwidth(): number {
    let widest = 0;
    for (let i = 0; i < this.size; i++) widest = Math.max(widest, i - (this.first[i] as number));
    return widest;
  }

  /** Adds to entry (row >= col); the column must lie inside the row envelope. */
  add(row: number, col: number, value: number): void {
    const index = (this.offset[row] as number) + col - (this.first[row] as number);
    this.values[index] = (this.values[index] as number) + value;
  }

  /** Factorises in place. Returns the first row whose pivot is <= tolerance x its own diagonal (mechanism), or -1. */
  factorize(pivotTolerance: number): number {
    const { size, first, offset, values } = this;
    for (let i = 0; i < size; i++) {
      const fi = first[i] as number;
      const oi = offset[i] as number;
      for (let j = fi; j <= i; j++) {
        const fj = first[j] as number;
        const oj = offset[j] as number;
        const original = values[oi + j - fi] as number;
        let sum = original;
        for (let k = Math.max(fi, fj); k < j; k++) sum -= (values[oi + k - fi] as number) * (values[oj + k - fj] as number);
        if (j < i) {
          values[oi + j - fi] = sum / (values[oj + j - fj] as number);
        } else {
          if (!(sum > pivotTolerance * original)) return i;
          values[oi + j - fi] = Math.sqrt(sum);
        }
      }
    }
    return -1;
  }

  /** Solves L L^T x = b after `factorize`; returns a new array. */
  solve(rhs: Float64Array): Float64Array {
    const { size, first, offset, values } = this;
    const x = Float64Array.from(rhs);
    for (let i = 0; i < size; i++) {
      const fi = first[i] as number;
      const oi = offset[i] as number;
      let sum = x[i] as number;
      for (let j = fi; j < i; j++) sum -= (values[oi + j - fi] as number) * (x[j] as number);
      x[i] = sum / (values[oi + i - fi] as number);
    }
    for (let i = size - 1; i >= 0; i--) {
      const fi = first[i] as number;
      const oi = offset[i] as number;
      const xi = (x[i] as number) / (values[oi + i - fi] as number);
      x[i] = xi;
      for (let j = fi; j < i; j++) x[j] = (x[j] as number) - (values[oi + j - fi] as number) * xi;
    }
    return x;
  }
}
