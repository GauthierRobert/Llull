/**
 * Single-degree-of-freedom frequency response (PHY-09 §5.1, TR-DYN-20): receptance, base transmissibility, peak and half-power points,
 * Miles' equation and the exact white-noise integrals. r = f / fn, zeta = viscous ratio. Pure, deterministic.
 */

/** Standard acceleration of gravity, m/s^2 (CGPM 1901, conventional value). */
export const STANDARD_GRAVITY = 9.80665;

export interface ComplexValue {
  readonly re: number;
  readonly im: number;
}

const magnitudeOf = (value: ComplexValue): number => Math.hypot(value.re, value.im);
const phaseDegOf = (value: ComplexValue): number => (Math.atan2(value.im, value.re) * 180) / Math.PI;

/** 1 / (a + i b). */
export function reciprocal(re: number, im: number): ComplexValue {
  const den = re * re + im * im;
  return { re: re / den, im: -im / den };
}

/** Dynamic amplification k H(r) = 1 / (1 - r^2 + 2 i zeta r). */
export const receptance = (r: number, zeta: number): ComplexValue => reciprocal(1 - r * r, 2 * zeta * r);

/** Absolute base transmissibility T(r) = (1 + 2 i zeta r) / (1 - r^2 + 2 i zeta r). */
export function transmissibility(r: number, zeta: number): ComplexValue {
  const h = receptance(r, zeta);
  const b = 2 * zeta * r;
  return { re: h.re - b * h.im, im: h.im + b * h.re };
}

export const frfMagnitude = magnitudeOf;
export const frfPhaseDeg = phaseDegOf;

/** Peak of |k H|: r = sqrt(1 - 2 zeta^2), |kH|max = 1 / (2 zeta sqrt(1 - zeta^2)); null above zeta = 1/sqrt(2) (no resonant peak). */
export function receptancePeak(zeta: number): { readonly r: number; readonly amplification: number } | null {
  if (!(zeta > 0) || 2 * zeta * zeta >= 1) return null;
  return { r: Math.sqrt(1 - 2 * zeta * zeta), amplification: 1 / (2 * zeta * Math.sqrt(1 - zeta * zeta)) };
}

/** Half-power points r1, r2 (|H| = |H|max / sqrt 2, exact quadratic in r^2) and the estimate Q = 1 / (r2 - r1). */
export function halfPower(zeta: number): { readonly r1: number; readonly r2: number; readonly q: number } | null {
  if (receptancePeak(zeta) === null) return null;
  const rad = 2 * zeta * Math.sqrt(1 - zeta * zeta);
  const low = 1 - 2 * zeta * zeta - rad;
  if (!(low > 0)) return null;
  const r1 = Math.sqrt(low);
  const r2 = Math.sqrt(1 - 2 * zeta * zeta + rad);
  return { r1, r2, q: 1 / (r2 - r1) };
}

/** Miles' equation sqrt(pi/2 fn Q W) (J. W. Miles 1954): a quick check, never an answer of record (FR-DYN-08). */
export const milesGrms = (fnHz: number, q: number, asdG2PerHz: number): number => Math.sqrt((Math.PI / 2) * fnHz * q * asdG2PerHz);

/** Exact absolute-acceleration rms of an SDOF on a white base ASD W (g^2/Hz): sqrt(W fn pi (1 + 4 zeta^2) / (4 zeta)), in g. */
export const whiteNoiseAccelerationRms = (fnHz: number, zeta: number, asdG2PerHz: number): number =>
  Math.sqrt((asdG2PerHz * fnHz * Math.PI * (1 + 4 * zeta * zeta)) / (4 * zeta));

/** Exact relative-displacement rms on a white base ASD: sqrt(W g^2 / (8 zeta wn^3)), in metres (W in g^2/Hz, g = 9.80665 m/s^2). */
export function whiteNoiseRelativeDisplacementRms(fnHz: number, zeta: number, asdG2PerHz: number): number {
  const wn = 2 * Math.PI * fnHz;
  return Math.sqrt((asdG2PerHz * STANDARD_GRAVITY * STANDARD_GRAVITY) / (8 * zeta * wn ** 3));
}
