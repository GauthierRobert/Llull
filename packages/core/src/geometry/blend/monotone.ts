/**
 * The monotone radius law of an edge blend (BLD 13.11.5 left, DES-6c): a C1 piecewise cubic Hermite curve through the stations (t, radius) that never
 * overshoots them (Fritsch-Carlson / PCHIP slopes: zero at a local extremum, the weighted harmonic mean of the neighbouring secants elsewhere) with zero
 * slope at both ends, like the kernel's smooth law. Between two stations the radius stays between their radii, so it never drops below the smallest station.
 * Pure: the native kernel builds the same curve from the same stations (`cpp/law_fillet.cxx`, `monotone_slopes`); `tests/unit/blendMonotone.test.ts` pins the two.
 * @invariant slopes are in radius per unit t; the pieces are cubic Hermite polynomials, so the value, the slope and the integral are exact in closed form
 */

export interface Station {
  readonly t: number;
  readonly size: number;
}

/** Slope (radius per unit t) at every station of `stations` (at least 2, `t` strictly increasing): zero at both ends. */
export function monotoneSlopes(stations: readonly Station[]): number[] {
  const count = stations.length;
  const slopes = new Array<number>(count).fill(0);
  if (count < 3) return slopes;
  const widths = stations.slice(1).map((station, k) => station.t - (stations[k] as Station).t);
  const secants = stations.slice(1).map((station, k) => (station.size - (stations[k] as Station).size) / (widths[k] as number));
  for (let k = 1; k + 1 < count; k++) {
    const [before, after] = [secants[k - 1] as number, secants[k] as number];
    if (before * after <= 0) continue;
    const [hBefore, hAfter] = [widths[k - 1] as number, widths[k] as number];
    const [w1, w2] = [2 * hAfter + hBefore, hAfter + 2 * hBefore];
    slopes[k] = (w1 + w2) / (w1 / before + w2 / after);
  }
  return slopes;
}

/** Radius of the monotone law through `stations` at `t` in [0, 1] (the stations hold the ends: the first at t = 0, the last at t = 1). */
export function monotoneRadius(stations: readonly Station[], t: number, slopes: readonly number[] = monotoneSlopes(stations)): number {
  const last = stations.length - 1;
  if (t <= (stations[0] as Station).t) return (stations[0] as Station).size;
  if (t >= (stations[last] as Station).t) return (stations[last] as Station).size;
  let k = 0;
  while (k + 1 < last && t > (stations[k + 1] as Station).t) k++;
  const [a, b] = [stations[k] as Station, stations[k + 1] as Station];
  const h = b.t - a.t;
  const u = (t - a.t) / h;
  const [u2, u3] = [u * u, u * u * u];
  return (
    (2 * u3 - 3 * u2 + 1) * a.size +
    (u3 - 2 * u2 + u) * h * (slopes[k] as number) +
    (-2 * u3 + 3 * u2) * b.size +
    (u3 - u2) * h * (slopes[k + 1] as number)
  );
}

/** Largest |dr/dt| of the law, read on 65 points of every piece (the derivative of a piece is a quadratic: the sampling error is far below the 5 % margin of the steepness rule). */
export function monotoneMaxSlope(stations: readonly Station[]): number {
  const slopes = monotoneSlopes(stations);
  let worst = 0;
  for (let k = 0; k + 1 < stations.length; k++) {
    const [a, b] = [stations[k] as Station, stations[k + 1] as Station];
    const secant = (b.size - a.size) / (b.t - a.t);
    const [m0, m1] = [slopes[k] as number, slopes[k + 1] as number];
    for (let step = 0; step <= 64; step++) {
      const u = step / 64;
      const slope = (6 * u - 6 * u * u) * secant + (3 * u * u - 4 * u + 1) * m0 + (3 * u * u - 2 * u) * m1;
      worst = Math.max(worst, Math.abs(slope));
    }
  }
  return worst;
}
