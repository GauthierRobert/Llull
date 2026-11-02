/**
 * Skyline (variable-band) symmetric matrix with in-place Cholesky of its Jacobi-scaled form (D^-1/2 A D^-1/2 = L L^T).
 * Row i stores columns first[i]..i.
 */
export class Skyline {
  readonly size: number;
  readonly first: Int32Array;
  readonly offset: Int32Array;
  readonly values: Float64Array;
  private scale: Float64Array = new Float64Array(0);

  /** Stored entries for an envelope, as a plain number (callers cap it before allocating). */
  static profileSize(first: Int32Array): number {
    let total = 0;
    for (let i = 0; i < first.length; i++) total += i - (first[i] as number) + 1;
    return total;
  }

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

  /** Jacobi-scales then factorises in place. Returns the first row with a non-positive diagonal or a scaled pivot <= tolerance (mechanism), or -1. */
  factorize(pivotTolerance: number): number {
    const { size, first, offset, values } = this;
    const scale = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const diagonal = values[(offset[i] as number) + i - (first[i] as number)] as number;
      if (!(diagonal > 0) || !Number.isFinite(diagonal)) return i;
      scale[i] = 1 / Math.sqrt(diagonal);
    }
    for (let i = 0; i < size; i++) {
      for (let j = first[i] as number; j <= i; j++) {
        const at = (offset[i] as number) + j - (first[i] as number);
        values[at] = (values[at] as number) * (scale[i] as number) * (scale[j] as number);
      }
    }
    this.scale = scale;
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
    const { scale } = this;
    const x = Float64Array.from(rhs, (v, i) => v * (scale[i] as number));
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
    for (let i = 0; i < size; i++) x[i] = (x[i] as number) * (scale[i] as number);
    return x;
  }
}
