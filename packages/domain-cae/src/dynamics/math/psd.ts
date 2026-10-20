/**
 * Acceleration spectral density helpers (PHY-09 §5.3, TR-DYN-43): log-log interpolation between breakpoints and the exact segment
 * integral W1 f1 / (n + 1) ((f2/f1)^(n+1) - 1) (W1 f1 ln(f2/f1) for n = -1), n = ln(W2/W1) / ln(f2/f1). Pure, deterministic.
 */

export type AsdPoint = readonly [fHz: number, level: number];

export interface AsdSegment {
  readonly f1Hz: number;
  readonly f2Hz: number;
  readonly w1: number;
  readonly w2: number;
  readonly slope: number;
  readonly slopeDbPerOct: number;
  readonly area: number;
}

/** Reason the breakpoints are not a spectrum (null when valid): >= 2 points, finite, f > 0 strictly increasing, level > 0. */
export function spectrumProblem(points: readonly (readonly number[])[]): { readonly index: number; readonly message: string } | null {
  if (points.length < 2) return { index: points.length, message: 'a spectrum needs at least 2 breakpoints' };
  for (const [index, point] of points.entries()) {
    const [f, level] = point;
    if (point.length !== 2 || f === undefined || level === undefined || !Number.isFinite(f) || !Number.isFinite(level))
      return { index, message: `breakpoint ${index} must be two finite numbers [fHz, level]` };
    if (!(f > 0) || !(level > 0)) return { index, message: `breakpoint ${index} needs fHz > 0 and level > 0` };
    const previous = points[index - 1]?.[0];
    if (previous !== undefined && !(f > previous)) return { index, message: `breakpoint ${index}: frequencies must strictly increase` };
  }
  return null;
}

const slopeOf = (f1: number, w1: number, f2: number, w2: number): number => Math.log(w2 / w1) / Math.log(f2 / f1);

/** Exact area of W1 (f/f1)^n over [f1, f2]. */
function segmentArea(f1: number, w1: number, f2: number, n: number): number {
  if (Math.abs(n + 1) < 1e-12) return w1 * f1 * Math.log(f2 / f1);
  return ((w1 * f1) / (n + 1)) * ((f2 / f1) ** (n + 1) - 1);
}

/** ASD level at `fHz` (log-log between breakpoints, 0 outside the spectrum). */
export function asdAt(points: readonly AsdPoint[], fHz: number): number {
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [f1, w1] = points[i] ?? [0, 0];
    const [f2, w2] = points[i + 1] ?? [0, 0];
    if (f1 <= fHz && fHz <= f2) return w1 * (fHz / f1) ** slopeOf(f1, w1, f2, w2);
  }
  return 0;
}

/**
 * Segments of the spectrum inside `band` (default: the whole spectrum), each clipped to the band with the level of its power law, and
 * their exact areas; grms = sqrt(total).
 */
export function integrateAsd(
  points: readonly AsdPoint[],
  band?: readonly [number, number],
): { readonly segments: readonly AsdSegment[]; readonly total: number; readonly rms: number } {
  const segments: AsdSegment[] = [];
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [f1, w1] = points[i] ?? [0, 0];
    const [f2, w2] = points[i + 1] ?? [0, 0];
    const n = slopeOf(f1, w1, f2, w2);
    const lo = band === undefined ? f1 : Math.max(f1, band[0]);
    const hi = band === undefined ? f2 : Math.min(f2, band[1]);
    if (!(hi > lo)) continue;
    const wLo = lo === f1 ? w1 : w1 * (lo / f1) ** n;
    const wHi = hi === f2 ? w2 : w1 * (hi / f1) ** n;
    const area = segmentArea(lo, wLo, hi, n);
    total += area;
    segments.push({ f1Hz: lo, f2Hz: hi, w1: wLo, w2: wHi, slope: n, slopeDbPerOct: 10 * n * Math.log10(2), area });
  }
  return { segments, total, rms: Math.sqrt(total) };
}
