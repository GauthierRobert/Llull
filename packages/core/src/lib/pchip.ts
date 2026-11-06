/** Monotone cubic (PCHIP, Fritsch-Carlson) interpolation of tabulated data, clamped at its ends. */

/** Piecewise cubic Hermite slopes that keep the data monotone (Fritsch-Carlson with the harmonic mean). */
export function pchipSlopes(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  const h = xs.slice(1).map((x, i) => x - (xs[i] ?? 0));
  const delta = h.map((step, i) => ((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / step);
  if (n === 2) return [delta[0] ?? 0, delta[0] ?? 0];
  const slopes = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const [left, right] = [delta[i - 1] ?? 0, delta[i] ?? 0];
    if (left * right > 0) {
      const [hl, hr] = [h[i - 1] ?? 1, h[i] ?? 1];
      const [w1, w2] = [2 * hr + hl, hr + 2 * hl];
      slopes[i] = (w1 + w2) / (w1 / left + w2 / right);
    }
  }
  const end = (h0: number, h1: number, d0: number, d1: number): number => {
    const value = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(value) !== Math.sign(d0)) return 0;
    if (Math.sign(d0) !== Math.sign(d1) && Math.abs(value) > 3 * Math.abs(d0)) return 3 * d0;
    return value;
  };
  slopes[0] = end(h[0] ?? 1, h[1] ?? 1, delta[0] ?? 0, delta[1] ?? 0);
  slopes[n - 1] = end(h[n - 2] ?? 1, h[n - 3] ?? 1, delta[n - 2] ?? 0, delta[n - 3] ?? 0);
  return slopes;
}

export interface HermitePoint {
  readonly value: number;
  readonly slope: number;
  readonly curvature: number;
}

/** Value, first and second derivative at `x` of the Hermite cubic through (xs, ys, slopes); the end values (zero derivatives) outside the data. */
export function pchipEvaluate(xs: readonly number[], ys: readonly number[], slopes: readonly number[], x: number): HermitePoint {
  const n = xs.length;
  const first = xs[0];
  const last = xs[n - 1];
  if (first === undefined || last === undefined) return { value: 0, slope: 0, curvature: 0 };
  if (x <= first) return { value: ys[0] ?? 0, slope: x < first ? 0 : (slopes[0] ?? 0), curvature: 0 };
  if (x >= last) return { value: ys[n - 1] ?? 0, slope: x > last ? 0 : (slopes[n - 1] ?? 0), curvature: 0 };
  let upper = 1;
  while (upper < n - 1 && (xs[upper] ?? Infinity) < x) upper++;
  const [x0, x1] = [xs[upper - 1] ?? 0, xs[upper] ?? 1];
  const [y0, y1] = [ys[upper - 1] ?? 0, ys[upper] ?? 0];
  const [m0, m1] = [slopes[upper - 1] ?? 0, slopes[upper] ?? 0];
  const width = x1 - x0;
  const t = (x - x0) / width;
  const [t2, t3] = [t * t, t * t * t];
  return {
    value: (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * width * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * width * m1,
    slope: ((6 * t2 - 6 * t) * y0 + (3 * t2 - 4 * t + 1) * width * m0 + (-6 * t2 + 6 * t) * y1 + (3 * t2 - 2 * t) * width * m1) / width,
    curvature: ((12 * t - 6) * y0 + (6 * t - 4) * width * m0 + (-12 * t + 6) * y1 + (6 * t - 2) * width * m1) / (width * width),
  };
}

/** Value at `x` of the PCHIP through (xs, ys); clamped to the end values outside the data. */
export function pchipAt(xs: readonly number[], ys: readonly number[], x: number): number {
  return pchipEvaluate(xs, ys, pchipSlopes(xs, ys), x).value;
}
