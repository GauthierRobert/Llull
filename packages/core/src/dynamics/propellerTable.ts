/**
 * Propeller coefficients against advance ratio (FR-FPR-75, TECHNICAL_SPEC 5.8): J = V / (n D) with n in rev/s; C_T(J) and C_P(J) by monotone
 * cubic (PCHIP, Fritsch-Carlson) interpolation of the table, clamped at its ends. J = 0 uses the propeller's static coefficients.
 */

import type { PropellerLoad } from '../model/dynamics';

/** Piecewise cubic Hermite slopes that keep the data monotone (Fritsch-Carlson with the harmonic mean). */
function pchipSlopes(xs: readonly number[], ys: readonly number[]): number[] {
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

/** Value at `x` of the PCHIP through (xs, ys); clamped to the end values outside the data. */
export function pchipAt(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  const first = xs[0];
  const last = xs[n - 1];
  if (first === undefined || last === undefined) return 0;
  if (x <= first) return ys[0] ?? 0;
  if (x >= last) return ys[n - 1] ?? 0;
  let upper = 1;
  while (upper < n - 1 && (xs[upper] ?? Infinity) < x) upper++;
  const slopes = pchipSlopes(xs, ys);
  const [x0, x1] = [xs[upper - 1] ?? 0, xs[upper] ?? 1];
  const [y0, y1] = [ys[upper - 1] ?? 0, ys[upper] ?? 0];
  const [m0, m1] = [slopes[upper - 1] ?? 0, slopes[upper] ?? 0];
  const width = x1 - x0;
  const t = (x - x0) / width;
  const [t2, t3] = [t * t, t * t * t];
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * width * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * width * m1;
}

export interface PropellerCoefficients {
  readonly advanceRatio: number;
  readonly thrustCoefficient: number;
  readonly powerCoefficient: number;
  /** J lies beyond the last table point (the coefficients are held at the end value): FPR_OUTSIDE_VALIDATED_RANGE. */
  readonly outsideTable: boolean;
  /** The coefficients come from the table (J > 0) rather than the static pair. */
  readonly tabulated: boolean;
}

/** Advance ratio of a propeller at shaft speed `omega` (rad/s): V / (n D), 0 when it is not turning or has no airspeed. */
export function advanceRatio(propeller: PropellerLoad, omega: number): number {
  const n = Math.abs(omega) / (2 * Math.PI);
  return n > 0 ? (propeller.airspeedMps ?? 0) / (n * propeller.diameter) : 0;
}

/** C_T, C_P of `propeller` at shaft speed `omega` (rad/s): the table by PCHIP when J > 0 and a table exists, else the static pair. */
export function propellerCoefficients(propeller: PropellerLoad, omega: number): PropellerCoefficients {
  const j = advanceRatio(propeller, omega);
  const { table } = propeller;
  if (table === undefined || !(j > 0))
    return {
      advanceRatio: j,
      thrustCoefficient: propeller.thrustCoefficient,
      powerCoefficient: propeller.powerCoefficient,
      outsideTable: false,
      tabulated: false,
    };
  const points = [...table.points].sort((a, b) => a[0] - b[0]);
  const js = points.map((point) => point[0]);
  const lastJ = js[js.length - 1] ?? 0;
  return {
    advanceRatio: j,
    thrustCoefficient: pchipAt(
      js,
      points.map((point) => point[1]),
      j,
    ),
    powerCoefficient: pchipAt(
      js,
      points.map((point) => point[2]),
      j,
    ),
    outsideTable: j > lastJ,
    tabulated: true,
  };
}
