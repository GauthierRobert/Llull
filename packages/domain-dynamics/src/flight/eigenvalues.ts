/**
 * Eigenvalues of a small real, non-symmetric matrix (the state matrix of a linearised flight): balancing, reduction to upper Hessenberg form by
 * stabilised elimination, then the shifted double-step QR iteration (EISPACK balanc / elmhes / hqr). Deterministic, pure.
 */

export interface ComplexValue {
  readonly re: number;
  readonly im: number;
}

const RADIX = 2;
const MAX_ITERATIONS = 60;

/** Scale rows and columns by powers of two so their norms are comparable (eigenvalues unchanged). */
function balance(a: number[][]): void {
  const n = a.length;
  let settled = false;
  while (!settled) {
    settled = true;
    for (let i = 0; i < n; i += 1) {
      let column = 0;
      let row = 0;
      for (let j = 0; j < n; j += 1) {
        if (j === i) continue;
        column += Math.abs(a[j]?.[i] ?? 0);
        row += Math.abs(a[i]?.[j] ?? 0);
      }
      if (column === 0 || row === 0) continue;
      let factor = 1;
      const total = column + row;
      let low = column;
      while (low < row / RADIX) {
        factor *= RADIX;
        low *= RADIX * RADIX;
      }
      while (low > row * RADIX) {
        factor /= RADIX;
        low /= RADIX * RADIX;
      }
      if ((low + row) / factor >= 0.95 * total) continue;
      settled = false;
      const rowScale = 1 / factor;
      const own = a[i] as number[];
      for (let j = 0; j < n; j += 1) own[j] = (own[j] ?? 0) * rowScale;
      for (let j = 0; j < n; j += 1) (a[j] as number[])[i] = ((a[j] as number[])[i] ?? 0) * factor;
    }
  }
}

/** Upper Hessenberg form by Gaussian elimination with pivoting (similarity transform). */
function hessenberg(a: number[][]): void {
  const n = a.length;
  const at = (i: number, j: number): number => (a[i] as number[])[j] ?? 0;
  for (let m = 1; m < n - 1; m += 1) {
    let x = 0;
    let pivot = m;
    for (let j = m; j < n; j += 1) {
      if (Math.abs(at(j, m - 1)) > Math.abs(x)) {
        x = at(j, m - 1);
        pivot = j;
      }
    }
    if (pivot !== m) {
      for (let j = m - 1; j < n; j += 1) [(a[pivot] as number[])[j], (a[m] as number[])[j]] = [at(m, j), at(pivot, j)];
      for (let j = 0; j < n; j += 1) [(a[j] as number[])[pivot], (a[j] as number[])[m]] = [at(j, m), at(j, pivot)];
    }
    if (x === 0) continue;
    for (let i = m + 1; i < n; i += 1) {
      const y = at(i, m - 1) / x;
      if (y === 0) continue;
      (a[i] as number[])[m - 1] = y;
      for (let j = m; j < n; j += 1) (a[i] as number[])[j] = at(i, j) - y * at(m, j);
      for (let j = 0; j < n; j += 1) (a[j] as number[])[m] = at(j, m) + y * at(j, i);
    }
  }
  for (let i = 2; i < n; i += 1) for (let j = 0; j < i - 1; j += 1) (a[i] as number[])[j] = 0;
}

const sign = (magnitude: number, of: number): number => (of >= 0 ? Math.abs(magnitude) : -Math.abs(magnitude));

/**
 * All eigenvalues of the square matrix `matrix` (rows), ordered by real part then imaginary part, both descending; null when the QR iteration
 * does not converge (not seen on a finite matrix of a few tens of states) or the matrix has a non-finite entry.
 */
export function eigenvalues(matrix: readonly (readonly number[])[]): ComplexValue[] | null {
  const n = matrix.length;
  if (n === 0) return [];
  if (matrix.some((row) => row.length !== n || row.some((value) => !Number.isFinite(value)))) return null;
  const a = matrix.map((row) => [...row]);
  balance(a);
  hessenberg(a);
  const at = (i: number, j: number): number => (a[i] as number[])[j] ?? 0;
  const set = (i: number, j: number, value: number): void => void ((a[i] as number[])[j] = value);
  const out: ComplexValue[] = [];
  let norm = 0;
  for (let i = 0; i < n; i += 1) for (let j = Math.max(i - 1, 0); j < n; j += 1) norm += Math.abs(at(i, j));
  let nn = n - 1;
  let shift = 0;
  while (nn >= 0) {
    let iterations = 0;
    let deflated = false;
    while (!deflated) {
      let l = nn;
      for (; l >= 1; l -= 1) {
        let s = Math.abs(at(l - 1, l - 1)) + Math.abs(at(l, l));
        if (s === 0) s = norm;
        if (Math.abs(at(l, l - 1)) + s === s) {
          set(l, l - 1, 0);
          break;
        }
      }
      let x = at(nn, nn);
      if (l === nn) {
        out.push({ re: x + shift, im: 0 });
        nn -= 1;
        deflated = true;
        continue;
      }
      let y = at(nn - 1, nn - 1);
      let w = at(nn, nn - 1) * at(nn - 1, nn);
      if (l === nn - 1) {
        const p = 0.5 * (y - x);
        const q = p * p + w;
        const z = Math.sqrt(Math.abs(q));
        x += shift;
        if (q >= 0) {
          const root = p + sign(z, p);
          out.push({ re: x + root, im: 0 }, { re: root !== 0 ? x - w / root : x + root, im: 0 });
        } else {
          out.push({ re: x + p, im: z }, { re: x + p, im: -z });
        }
        nn -= 2;
        deflated = true;
        continue;
      }
      if (iterations >= MAX_ITERATIONS) return null;
      if (iterations === 10 || iterations === 20) {
        shift += x;
        for (let i = 0; i <= nn; i += 1) set(i, i, at(i, i) - x);
        const s = Math.abs(at(nn, nn - 1)) + Math.abs(at(nn - 1, nn - 2));
        x = y = 0.75 * s;
        w = -0.4375 * s * s;
      }
      iterations += 1;
      let m = nn - 2;
      let p = 0;
      let q = 0;
      let r = 0;
      for (; m >= l; m -= 1) {
        const z = at(m, m);
        r = x - z;
        const s0 = y - z;
        p = (r * s0 - w) / at(m + 1, m) + at(m, m + 1);
        q = at(m + 1, m + 1) - z - r - s0;
        r = at(m + 2, m + 1);
        const s = Math.abs(p) + Math.abs(q) + Math.abs(r);
        p /= s;
        q /= s;
        r /= s;
        if (m === l) break;
        const u = Math.abs(at(m, m - 1)) * (Math.abs(q) + Math.abs(r));
        const v = Math.abs(p) * (Math.abs(at(m - 1, m - 1)) + Math.abs(z) + Math.abs(at(m + 1, m + 1)));
        if (u + v === v) break;
      }
      for (let i = m + 2; i <= nn; i += 1) {
        set(i, i - 2, 0);
        if (i !== m + 2) set(i, i - 3, 0);
      }
      for (let k = m; k <= nn - 1; k += 1) {
        if (k !== m) {
          p = at(k, k - 1);
          q = at(k + 1, k - 1);
          r = k !== nn - 1 ? at(k + 2, k - 1) : 0;
          x = Math.abs(p) + Math.abs(q) + Math.abs(r);
          if (x !== 0) {
            p /= x;
            q /= x;
            r /= x;
          }
        }
        const s = sign(Math.sqrt(p * p + q * q + r * r), p);
        if (s === 0) continue;
        if (k === m) {
          if (l !== m) set(k, k - 1, -at(k, k - 1));
        } else set(k, k - 1, -s * x);
        p += s;
        x = p / s;
        y = q / s;
        const z = r / s;
        q /= p;
        r /= p;
        for (let j = k; j <= nn; j += 1) {
          let sum = at(k, j) + q * at(k + 1, j);
          if (k !== nn - 1) {
            sum += r * at(k + 2, j);
            set(k + 2, j, at(k + 2, j) - sum * z);
          }
          set(k + 1, j, at(k + 1, j) - sum * y);
          set(k, j, at(k, j) - sum * x);
        }
        const last = Math.min(nn, k + 3);
        for (let i = l; i <= last; i += 1) {
          let sum = x * at(i, k) + y * at(i, k + 1);
          if (k !== nn - 1) {
            sum += z * at(i, k + 2);
            set(i, k + 2, at(i, k + 2) - sum * r);
          }
          set(i, k + 1, at(i, k + 1) - sum * q);
          set(i, k, at(i, k) - sum);
        }
      }
    }
  }
  return out.sort((first, second) => second.re - first.re || second.im - first.im);
}
