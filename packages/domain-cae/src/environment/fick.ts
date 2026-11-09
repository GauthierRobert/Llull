/**
 * Fickian moisture diffusion through a plane sheet (Crank, The Mathematics of Diffusion; Shen & Springer 1976, J. Compos. Mater. 10, 2-20).
 * Plate of thickness h, both faces held at the boundary content from t = 0, uniform start, constant D:
 *   G(tau) = (M - Mi) / (Mb - Mi) = 1 - (8 / pi^2) sum_{j>=0} exp(-(2j+1)^2 pi^2 tau) / (2j+1)^2,   tau = D t / h^2.
 * Equilibrium content from relative humidity: M_inf = a RH^b (Shen & Springer).
 * @invariant pure; no I/O; the series stops when a term is below TERM_CUTOFF (named numeric default, FR-ENV-16)
 */

/** Series truncation: summation stops when one term falls below this (TR-ENV-05). */
const TERM_CUTOFF = 1e-17;

/** Below this tau the short-time form G = 4 sqrt(tau / pi) replaces the series (its exp(-1/(4 tau)) correction is under 1e-100). */
const SHORT_TIME_TAU = 1e-4;

/** Fractional uptake G in [0, 1] at dimensionless time tau = D t / h^2 (two faces exposed). */
export function fractionalUptake(tau: number): number {
  if (!(tau > 0)) return 0;
  if (tau < SHORT_TIME_TAU) return 4 * Math.sqrt(tau / Math.PI);
  const factor = Math.PI * Math.PI * tau;
  let sum = 0;
  for (let j = 0; ; j += 1) {
    const odd = 2 * j + 1;
    const term = Math.exp(-odd * odd * factor) / (odd * odd);
    if (term < TERM_CUTOFF) break;
    sum += term;
  }
  return Math.min(1, 1 - (8 / (Math.PI * Math.PI)) * sum);
}

/** G at the short-time switch: below it the inverse is closed form. */
const SHORT_TIME_FRACTION = 4 * Math.sqrt(SHORT_TIME_TAU / Math.PI);

/** Dimensionless time at which the fractional uptake reaches `fraction` in (0, 1); null when it is not reachable in double precision. */
export function timeToFraction(fraction: number): number | null {
  if (!(fraction > 0 && fraction < 1)) return null;
  if (fraction < SHORT_TIME_FRACTION) return (Math.PI * fraction * fraction) / 16;
  let low = SHORT_TIME_TAU;
  let high = 10;
  if (fractionalUptake(high) < fraction) return null;
  for (let step = 0; step < 200 && high / low - 1 > 1e-14; step += 1) {
    const mid = Math.sqrt(low * high);
    if (fractionalUptake(mid) < fraction) low = mid;
    else high = mid;
  }
  return Math.sqrt(low * high);
}

/** Equilibrium moisture content M_inf = a RH^b (percent of dry mass) for relative humidity `relativeHumidityPercent` in [0, 100]. */
export function equilibriumContent(a: number, b: number, relativeHumidityPercent: number): number {
  return a * relativeHumidityPercent ** b;
}

/** Moisture content at fractional uptake `g`: M = Mi + g (Mb - Mi); for desorption Mb is the dry boundary value. */
export function contentAt(initial: number, boundary: number, g: number): number {
  return initial + g * (boundary - initial);
}

/** Effective Fick thickness: a sealed face is the symmetry plane, so one face exposed behaves as both faces of a plate twice as thick. */
export const effectiveThickness = (thickness: number, faces: 'both' | 'one'): number => (faces === 'one' ? 2 * thickness : thickness);

/** `count` log-spaced values from `first` to `last` inclusive. */
export function logSpaced(first: number, last: number, count: number): number[] {
  const ratio = Math.log(last / first);
  return Array.from({ length: count }, (_, index) => (index === count - 1 ? last : first * Math.exp((ratio * index) / (count - 1))));
}

/** Dimensionless time of 99 % uptake: the end of the curve when no exposure is given. */
const tau99 = timeToFraction(0.99);
export const TAU_99: number = tau99 === null ? Number.NaN : tau99;
