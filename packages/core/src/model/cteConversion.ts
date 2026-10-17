/**
 * CTE conversions (PHY-04 TECHNICAL_SPEC §5.2, TR-TMC-15). Pure numbers: temperatures in K, coefficients in 1/K.
 * Instantaneous alpha_i(T) -> secant alpha_s(T; Tref) = (1/(T - Tref)) * integral of alpha_i from Tref to T, with alpha_s(Tref) = alpha_i(Tref).
 * Secant at Ta -> secant at Tb: alpha_b(T) = [alpha_a(T)(T - Ta) - alpha_a(Tb)(Tb - Ta)] / (T - Tb).
 */

export type Alpha = (temperature: number) => number;

/** An instantaneous CTE law with its exact integral. NaN outside the law's validity. */
export interface InstantaneousLaw {
  readonly alpha: Alpha;
  readonly integral: (from: number, to: number) => number;
}

/** alpha_i(T) = alpha0 + alpha1 (T - T0); the integral is the closed form. */
export function linearLaw(alpha0: number, alpha1: number, referenceTemperature: number): InstantaneousLaw {
  const alpha: Alpha = (temperature) => alpha0 + alpha1 * (temperature - referenceTemperature);
  return {
    alpha,
    integral: (from, to) => alpha0 * (to - from) + (alpha1 / 2) * ((to - referenceTemperature) ** 2 - (from - referenceTemperature) ** 2),
  };
}

/** Piecewise-linear table of [T, alpha] (strictly increasing T, at least two points): exact trapezoid integral, NaN outside the table. */
export function tableLaw(points: readonly (readonly [number, number])[]): InstantaneousLaw | undefined {
  if (
    points.length < 2 ||
    points.some(([t, a], i) => !Number.isFinite(t) || !Number.isFinite(a) || (i > 0 && t <= (points[i - 1]?.[0] ?? t)))
  ) {
    return undefined;
  }
  const first = points[0]?.[0] ?? 0;
  const last = points[points.length - 1]?.[0] ?? 0;
  const alpha: Alpha = (temperature) => {
    if (temperature < first || temperature > last) return Number.NaN;
    for (let i = 1; i < points.length; i += 1) {
      const [t0 = 0, a0 = 0] = points[i - 1] ?? [];
      const [t1 = 0, a1 = 0] = points[i] ?? [];
      if (temperature <= t1) return a0 + ((a1 - a0) * (temperature - t0)) / (t1 - t0);
    }
    return Number.NaN;
  };
  const integral = (from: number, to: number): number => {
    if (from > to) return -integral(to, from);
    if (from < first || to > last) return Number.NaN;
    let sum = 0;
    for (let i = 1; i < points.length; i += 1) {
      const [t0 = 0] = points[i - 1] ?? [];
      const [t1 = 0] = points[i] ?? [];
      const lo = Math.max(from, t0);
      const hi = Math.min(to, t1);
      if (hi > lo) sum += ((hi - lo) * (alpha(lo) + alpha(hi))) / 2;
    }
    return sum;
  };
  return { alpha, integral };
}

/** Secant CTE of `law` at `temperature` for the stress-free `reference` (NaN outside the law). */
export const secantFromInstantaneous = (law: InstantaneousLaw, reference: number, temperature: number): number =>
  temperature === reference ? law.alpha(temperature) : law.integral(reference, temperature) / (temperature - reference);

/** Thermal strain alpha_s (T - ref) of a secant CTE; 0 at the reference itself (where the secant value is not needed). */
export const secantStrain = (secant: Alpha, reference: number, temperature: number): number =>
  temperature === reference ? 0 : secant(temperature) * (temperature - reference);

/** Secant CTE re-referenced from `from` to `to`; NaN at T = `to` (needs the instantaneous value there). */
export function reReferenceSecant(secant: Alpha, from: number, to: number, temperature: number): number {
  if (temperature === to) return Number.NaN;
  return (secantStrain(secant, from, temperature) - secantStrain(secant, from, to)) / (temperature - to);
}

export interface SampledIntegral {
  readonly value: number;
  /** Richardson estimate |S_n - S_(n/2)| / 15 of the Simpson error. */
  readonly errorEstimate: number;
  readonly intervals: number;
}

const MAX_SAMPLING_STEP_KELVIN = 10;

function simpson(f: Alpha, a: number, b: number, intervals: number): number {
  const h = (b - a) / intervals;
  let sum = f(a) + f(b);
  for (let i = 1; i < intervals; i += 1) sum += (i % 2 === 1 ? 4 : 2) * f(a + i * h);
  return (sum * h) / 3;
}

/** Simpson integral of f over [a, b] with steps <= `maxStep` K (a multiple of four intervals) and an error estimate; NaN if f is not finite. */
export function sampledIntegral(f: Alpha, a: number, b: number, maxStep: number = MAX_SAMPLING_STEP_KELVIN): SampledIntegral {
  if (a === b) return { value: 0, errorEstimate: 0, intervals: 0 };
  const intervals = Math.max(4, 4 * Math.ceil(Math.abs(b - a) / (4 * maxStep)));
  const fine = simpson(f, a, b, intervals);
  const coarse = simpson(f, a, b, intervals / 2);
  return { value: fine, errorEstimate: Math.abs(fine - coarse) / 15, intervals };
}
