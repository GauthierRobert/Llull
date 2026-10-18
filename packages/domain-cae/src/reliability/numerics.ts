/** Pure numerics of the reliability pack: Φ and Φ⁻¹ in double precision, Gamma, Cholesky and a symmetric eigen solver. */

const SQRT2 = Math.SQRT2;
const SQRT_PI = Math.sqrt(Math.PI);

/** erfc(x) for x >= 0: positive power series below 2 (no cancellation), continued fraction above. Relative error ~1e-14. */
function erfcPositive(x: number): number {
  if (x < 2) {
    let term = x;
    let sum = x;
    for (let n = 1; n < 200; n += 1) {
      term *= (2 * x * x) / (2 * n + 1);
      sum += term;
      if (term < 1e-18 * sum) break;
    }
    return 1 - (2 / SQRT_PI) * Math.exp(-x * x) * sum;
  }
  let fraction = x;
  for (let k = 160; k >= 1; k -= 1) fraction = x + k / 2 / fraction;
  return Math.exp(-x * x) / SQRT_PI / fraction;
}

const erfc = (x: number): number => (x >= 0 ? erfcPositive(x) : 2 - erfcPositive(-x));

/** Standard normal CDF Φ(x) (relative error < 1e-12 on [-37, 8]). */
export const normalCdf = (x: number): number => 0.5 * erfc(-x / SQRT2);

const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
];
const ACKLAM_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783,
];
const ACKLAM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

const poly = (c: readonly number[], x: number): number => c.reduce((acc, coefficient) => acc * x + coefficient, 0);

/**
 * Φ⁻¹(p) for p in (0, 1): Acklam's rational start, two Halley refinements against `normalCdf`.
 * @failure p outside (0, 1) -> NaN
 */
export function normalInv(p: number): number {
  if (!(p > 0 && p < 1)) return Number.NaN;
  let x: number;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = poly(ACKLAM_C, q) / (poly(ACKLAM_D, q) * q + 1);
  } else if (p > 1 - 0.02425) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -poly(ACKLAM_C, q) / (poly(ACKLAM_D, q) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = (poly(ACKLAM_A, r) * q) / (poly(ACKLAM_B, r) * r + 1);
  }
  for (let i = 0; i < 2; i += 1) {
    const error = normalCdf(x) - p;
    const u = (error * Math.sqrt(2 * Math.PI)) / Math.exp(-0.5 * x * x);
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Γ(z) for z > 0 (Lanczos, relative error ~1e-14). */
export function gamma(z: number): number {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  const x = z - 1;
  let sum = LANCZOS[0] ?? 0;
  for (let i = 1; i < 9; i += 1) sum += (LANCZOS[i] ?? 0) / (x + i);
  const t = x + 7.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * sum;
}

/** Lower Cholesky factor of a symmetric matrix, or null when it is not positive definite. */
export function cholesky(matrix: readonly (readonly number[])[]): number[][] | null {
  const n = matrix.length;
  const lower = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    const row = lower[i] as number[];
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i]?.[j] ?? 0;
      for (let k = 0; k < j; k += 1) sum -= (row[k] ?? 0) * (lower[j]?.[k] ?? 0);
      if (i === j) {
        if (!(sum > 1e-12)) return null;
        row[j] = Math.sqrt(sum);
      } else row[j] = sum / (lower[j]?.[j] ?? 1);
    }
  }
  return lower;
}

/** Eigenvalues of a symmetric matrix (cyclic Jacobi rotations), ascending. */
export function symmetricEigenvalues(matrix: readonly (readonly number[])[]): number[] {
  const n = matrix.length;
  const a = matrix.map((row) => [...row]);
  const at = (i: number, j: number): number => a[i]?.[j] ?? 0;
  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) off += at(i, j) ** 2;
    if (off < 1e-26) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(at(p, q)) < 1e-300) continue;
        const theta = (at(q, q) - at(p, p)) / (2 * at(p, q));
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = at(k, p);
          const akq = at(k, q);
          (a[k] as number[])[p] = c * akp - s * akq;
          (a[k] as number[])[q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = at(p, k);
          const aqk = at(q, k);
          (a[p] as number[])[k] = c * apk - s * aqk;
          (a[q] as number[])[k] = s * apk + c * aqk;
        }
      }
    }
  }
  return a.map((row, i) => row[i] ?? 0).sort((x, y) => x - y);
}
