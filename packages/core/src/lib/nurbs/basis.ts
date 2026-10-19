/** B-spline basis functions (Piegl & Tiller, The NURBS Book, A2.1 - A2.3) over a full knot vector. */

/** Knot span index i with U[i] <= u < U[i+1] (u = end of the domain maps to the last non-empty span); `poleCount` = n + 1. */
export function findSpan(poleCount: number, degree: number, u: number, knots: ReadonlyArray<number>): number {
  const n = poleCount - 1;
  if (u >= (knots[n + 1] as number)) return n;
  if (u <= (knots[degree] as number)) return degree;
  let low = degree;
  let high = n + 1;
  let mid = (low + high) >> 1;
  while (u < (knots[mid] as number) || u >= (knots[mid + 1] as number)) {
    if (u < (knots[mid] as number)) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/** The degree + 1 non-zero basis functions N_{span-degree..span}(u). */
export function basisFunctions(span: number, u: number, degree: number, knots: ReadonlyArray<number>): number[] {
  const basis = new Array<number>(degree + 1).fill(0);
  const left = new Array<number>(degree + 1).fill(0);
  const right = new Array<number>(degree + 1).fill(0);
  basis[0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = u - (knots[span + 1 - j] as number);
    right[j] = (knots[span + j] as number) - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denominator = (right[r + 1] as number) + (left[j - r] as number);
      const temp = denominator === 0 ? 0 : (basis[r] as number) / denominator;
      basis[r] = saved + (right[r + 1] as number) * temp;
      saved = (left[j - r] as number) * temp;
    }
    basis[j] = saved;
  }
  return basis;
}

/**
 * Basis functions and their derivatives: `result[k][j]` = k-th derivative of N_{span-degree+j}(u), k = 0..order (derivatives above the
 * degree are zero).
 */
export function basisDerivatives(span: number, u: number, degree: number, order: number, knots: ReadonlyArray<number>): number[][] {
  const ndu: number[][] = Array.from({ length: degree + 1 }, () => new Array<number>(degree + 1).fill(0));
  const left = new Array<number>(degree + 1).fill(0);
  const right = new Array<number>(degree + 1).fill(0);
  const at = (row: number, column: number): number => (ndu[row] as number[])[column] as number;
  const put = (row: number, column: number, value: number): void => {
    (ndu[row] as number[])[column] = value;
  };
  put(0, 0, 1);
  for (let j = 1; j <= degree; j++) {
    left[j] = u - (knots[span + 1 - j] as number);
    right[j] = (knots[span + j] as number) - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      put(j, r, (right[r + 1] as number) + (left[j - r] as number));
      const temp = at(r, j - 1) / at(j, r);
      put(r, j, saved + (right[r + 1] as number) * temp);
      saved = (left[j - r] as number) * temp;
    }
    put(j, j, saved);
  }
  const kMax = Math.min(order, degree);
  const ders: number[][] = Array.from({ length: order + 1 }, () => new Array<number>(degree + 1).fill(0));
  for (let j = 0; j <= degree; j++) (ders[0] as number[])[j] = at(j, degree);
  const rows: number[][] = [new Array<number>(degree + 1).fill(0), new Array<number>(degree + 1).fill(0)];
  for (let r = 0; r <= degree; r++) {
    let s1 = 0;
    let s2 = 1;
    (rows[0] as number[])[0] = 1;
    for (let k = 1; k <= kMax; k++) {
      let d = 0;
      const rk = r - k;
      const pk = degree - k;
      const current = rows[s1] as number[];
      const other = rows[s2] as number[];
      if (r >= k) {
        other[0] = (current[0] as number) / at(pk + 1, rk);
        d = (other[0] as number) * at(rk, pk);
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : degree - r;
      for (let j = j1; j <= j2; j++) {
        other[j] = ((current[j] as number) - (current[j - 1] as number)) / at(pk + 1, rk + j);
        d += (other[j] as number) * at(rk + j, pk);
      }
      if (r <= pk) {
        other[k] = -(current[k - 1] as number) / at(pk + 1, r);
        d += (other[k] as number) * at(r, pk);
      }
      (ders[k] as number[])[r] = d;
      const swap = s1;
      s1 = s2;
      s2 = swap;
    }
  }
  let factor = degree;
  for (let k = 1; k <= kMax; k++) {
    for (let j = 0; j <= degree; j++) (ders[k] as number[])[j] = ((ders[k] as number[])[j] as number) * factor;
    factor *= degree - k;
  }
  return ders;
}
