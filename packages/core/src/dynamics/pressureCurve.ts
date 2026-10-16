/**
 * Cylinder pressure as a function of the cycle angle phi (deg, 0 = firing TDC; 720 four-stroke, 360 two-stroke) on a 0.1 deg grid, plus
 * the geometry shared by every pressure model (TR-FPR-08). A curve is precomputed once per run; the force law only interpolates it.
 */

import { sliderTravel, type Slider } from './slider';

/** Grid step of every curve, deg (named, TR-FPR-08). */
export const STEP_DEG = 0.1;

export interface CylinderGeometry {
  readonly slider: Slider;
  readonly pistonAreaM2: number;
  readonly clearanceVolumeM3: number;
  readonly displacementM3: number;
}

export type CurveCode = 'FPR_PRESSURE_TABLE_GAP' | 'FPR_IMEP_UNREACHABLE' | 'FPR_PRESSURE_MODEL_INVALID';
export interface CurveRefusal {
  readonly error: string;
  readonly code: CurveCode;
}

export interface PressureCurve {
  readonly cycleDeg: number;
  /** Gauge pressure (Pa) at phi = k * STEP_DEG, k = 0..N (the last equals the first). */
  readonly gaugePa: Float64Array;
  readonly ambientPa: number;
  /** Highest absolute pressure, Pa, and its cycle angle. */
  readonly peakPa: number;
  readonly peakAngleDeg: number;
  /** Net indicated work per cycle, J: the loop integral of gauge pressure over the cylinder volume. */
  readonly workJ: number;
  /** Net IMEP = work / displacement, Pa. */
  readonly imepPa: number;
  /** Heat released per cycle, J (null for a table). */
  readonly heatJ: number | null;
}

export const cycleLength = (cycle: 'four_stroke' | 'two_stroke'): number => (cycle === 'four_stroke' ? 720 : 360);

const RADIANS_PER_DEG = Math.PI / 180;

/** Cylinder volume (m³) at cycle angle phi (deg), phi = 0 at the top position. */
export function volumeAt(geometry: CylinderGeometry, phiDeg: number): number {
  return geometry.clearanceVolumeM3 + geometry.pistonAreaM2 * sliderTravel(geometry.slider, phiDeg * RADIANS_PER_DEG);
}

/** The curve of a gauge-pressure grid: peak, work and IMEP computed here so every model reports them the same way. */
export function finishCurve(
  gaugePa: Float64Array,
  geometry: CylinderGeometry,
  ambientPa: number,
  cycleDeg: number,
  heatJ: number | null,
): PressureCurve {
  const cells = Math.round(cycleDeg / STEP_DEG);
  let work = 0;
  let peak = -Infinity;
  let peakAt = 0;
  let previousVolume = volumeAt(geometry, 0);
  for (let k = 0; k < cells; k++) {
    const volume = volumeAt(geometry, (k + 1) * STEP_DEG);
    work += 0.5 * ((gaugePa[k] ?? 0) + (gaugePa[k + 1] ?? 0)) * (volume - previousVolume);
    previousVolume = volume;
    if ((gaugePa[k] ?? 0) > peak) [peak, peakAt] = [gaugePa[k] ?? 0, k];
  }
  return {
    cycleDeg,
    gaugePa,
    ambientPa,
    peakPa: peak + ambientPa,
    peakAngleDeg: peakAt * STEP_DEG,
    workJ: work,
    imepPa: work / geometry.displacementM3,
    heatJ,
  };
}

/** Gauge pressure (Pa) at cycle angle phi (deg): linear interpolation, periodic in the cycle. */
export function gaugeAt(curve: PressureCurve, phiDeg: number): number {
  const wrapped = ((phiDeg % curve.cycleDeg) + curve.cycleDeg) % curve.cycleDeg;
  const position = wrapped / STEP_DEG;
  const index = Math.min(Math.floor(position), curve.gaugePa.length - 2);
  const fraction = position - index;
  return (curve.gaugePa[index] ?? 0) * (1 - fraction) + (curve.gaugePa[index + 1] ?? 0) * fraction;
}

/** Cumulative Wiebe burn fraction x_b = 1 - exp(-a ((psi - start) / duration)^(m + 1)) and its derivative per degree. */
export function burnFraction(
  burn: { startDeg: number; durationDeg: number; a: number; m: number },
  psiDeg: number,
): { x: number; rate: number } {
  const s = (psiDeg - burn.startDeg) / burn.durationDeg;
  if (s <= 0) return { x: 0, rate: 0 };
  const power = s ** (burn.m + 1);
  const x = 1 - Math.exp(-burn.a * power);
  return { x, rate: ((burn.a * (burn.m + 1) * s ** burn.m) / burn.durationDeg) * (1 - x) };
}

/** Index of cycle angle `phiDeg` on the grid (wrapped into the cycle). */
export function gridIndex(phiDeg: number, cycleDeg: number): number {
  const cells = Math.round(cycleDeg / STEP_DEG);
  return ((((Math.round(phiDeg / STEP_DEG) % cells) + cells) % cells) + cells) % cells;
}
