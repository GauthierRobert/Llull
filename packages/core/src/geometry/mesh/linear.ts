/** Tiny dense linear algebra for primitive fitting: symmetric 3x3 eigen-decomposition (Jacobi) and n x n solves (Gauss, partial pivoting). */

import type { Vec3 } from '../../model/vectors';

export type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

/** Eigenvalues (ascending) and unit eigenvectors of the symmetric matrix `m` (cyclic Jacobi, exact to round-off for 3x3). */
export function eigenSymmetric3(m: Mat3): { values: Vec3; vectors: [Vec3, Vec3, Vec3] } {
  const a: number[][] = m.map((row) => [...row]);
  const v: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off =
      Math.abs((a[0] as number[])[1] as number) + Math.abs((a[0] as number[])[2] as number) + Math.abs((a[1] as number[])[2] as number);
    if (off < 1e-300) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = (a[p] as number[])[q] as number;
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (((a[q] as number[])[q] as number) - ((a[p] as number[])[p] as number)) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const [akp, akq] = [(a[k] as number[])[p] as number, (a[k] as number[])[q] as number];
        (a[k] as number[])[p] = c * akp - s * akq;
        (a[k] as number[])[q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const [apk, aqk] = [(a[p] as number[])[k] as number, (a[q] as number[])[k] as number];
        (a[p] as number[])[k] = c * apk - s * aqk;
        (a[q] as number[])[k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const [vkp, vkq] = [(v[k] as number[])[p] as number, (v[k] as number[])[q] as number];
        (v[k] as number[])[p] = c * vkp - s * vkq;
        (v[k] as number[])[q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((x, y) => ((a[x] as number[])[x] as number) - ((a[y] as number[])[y] as number));
  const column = (j: number): Vec3 => [(v[0] as number[])[j] as number, (v[1] as number[])[j] as number, (v[2] as number[])[j] as number];
  const [i0, i1, i2] = order as [number, number, number];
  return {
    values: [(a[i0] as number[])[i0] as number, (a[i1] as number[])[i1] as number, (a[i2] as number[])[i2] as number],
    vectors: [column(i0), column(i1), column(i2)],
  };
}

/** Solution of `a x = b` (`a` n x n, row-major copy is made); null when singular. */
export function solveLinear(a: ReadonlyArray<ReadonlyArray<number>>, b: ReadonlyArray<number>): number[] | null {
  const n = b.length;
  const m: number[][] = a.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs((m[row] as number[])[col] as number) > Math.abs((m[pivot] as number[])[col] as number)) pivot = row;
    if (Math.abs((m[pivot] as number[])[col] as number) < 1e-300) return null;
    [m[col], m[pivot]] = [m[pivot] as number[], m[col] as number[]];
    for (let row = col + 1; row < n; row++) {
      const factor = ((m[row] as number[])[col] as number) / ((m[col] as number[])[col] as number);
      for (let k = col; k <= n; k++)
        (m[row] as number[])[k] = ((m[row] as number[])[k] as number) - factor * ((m[col] as number[])[k] as number);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = (m[row] as number[])[n] as number;
    for (let k = row + 1; k < n; k++) sum -= ((m[row] as number[])[k] as number) * (x[k] as number);
    x[row] = sum / ((m[row] as number[])[row] as number);
  }
  return x;
}

/**
 * Levenberg-Marquardt over `params` for the residual vector `residuals(params)`; central-difference Jacobian. Returns the best parameters seen
 * (the start when nothing improves). Deterministic.
 */
export function levenbergMarquardt(
  params: ReadonlyArray<number>,
  residuals: (p: ReadonlyArray<number>) => number[],
  iterations = 40,
): number[] {
  let current = [...params];
  let r = residuals(current);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const n = current.length;
    const jacobian: number[][] = r.map(() => new Array<number>(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = 1e-6 * Math.max(1, Math.abs(current[j] as number));
      const [plus, minus] = [[...current], [...current]];
      plus[j] = (plus[j] as number) + h;
      minus[j] = (minus[j] as number) - h;
      const [rp, rm] = [residuals(plus), residuals(minus)];
      for (let i = 0; i < r.length; i++) (jacobian[i] as number[])[j] = ((rp[i] as number) - (rm[i] as number)) / (2 * h);
    }
    const jtj: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const jtr = new Array<number>(n).fill(0);
    for (let i = 0; i < r.length; i++) {
      const row = jacobian[i] as number[];
      for (let a = 0; a < n; a++) {
        jtr[a] = (jtr[a] as number) + (row[a] as number) * (r[i] as number);
        for (let b = 0; b < n; b++) (jtj[a] as number[])[b] = ((jtj[a] as number[])[b] as number) + (row[a] as number) * (row[b] as number);
      }
    }
    let improved = false;
    for (let attempt = 0; attempt < 8 && !improved; attempt++) {
      const damped = jtj.map((row, a) => row.map((value, b) => (a === b ? value * (1 + lambda) + 1e-30 : value)));
      const step = solveLinear(
        damped,
        jtr.map((v) => -v),
      );
      if (step === null) {
        lambda *= 10;
        continue;
      }
      const trial = current.map((value, k) => value + (step[k] as number));
      const rt = residuals(trial);
      const costTrial = rt.reduce((s, v) => s + v * v, 0);
      if (Number.isFinite(costTrial) && costTrial < cost) {
        current = trial;
        r = rt;
        const done = cost - costTrial < 1e-30 * Math.max(cost, 1e-300);
        cost = costTrial;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        if (done) return current;
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  return current;
}
