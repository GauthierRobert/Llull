const SQRT_PI = Math.sqrt(Math.PI);

/** erfc(x) for x ≥ 0: positive power series below 2 (no cancellation), continued fraction above. */
function erfcPositive(x: number): number {
  if (x < 2) {
    let term = x;
    let sum = x;
    for (let n = 1; n < 200 && term >= 1e-18 * sum; n += 1) {
      term *= (2 * x * x) / (2 * n + 1);
      sum += term;
    }
    return 1 - (2 / SQRT_PI) * Math.exp(-x * x) * sum;
  }
  let fraction = x;
  for (let k = 160; k >= 1; k -= 1) fraction = x + k / 2 / fraction;
  return Math.exp(-x * x) / SQRT_PI / fraction;
}

/** Complementary error function, relative error < 1e-12 on the tested range. */
export const erfc = (x: number): number => (x >= 0 ? erfcPositive(x) : 2 - erfcPositive(-x));

/** Standard normal CDF Φ(z) = ½ erfc(−z/√2). */
export const normalCdf = (z: number): number => 0.5 * erfc(-z / Math.SQRT2);

/** Error function by the all-positive series erf(x) = 2/√π e^(−x²) Σ x^(2n+1) 2^n / (2n+1)!!; |x| ≥ 6 returns ±1, NaN and ±0 pass through. */
export function erf(x: number): number {
  if (x === 0 || Number.isNaN(x)) return x;
  const a = Math.abs(x);
  if (a >= 6) return Math.sign(x);
  let term = a;
  let sum = a;
  for (let n = 1; n < 1000 && term > sum * 1e-17; n += 1) {
    term *= (2 * a * a) / (2 * n + 1);
    sum += term;
  }
  const value = (2 / Math.sqrt(Math.PI)) * Math.exp(-a * a) * sum;
  return x < 0 ? -value : value;
}
