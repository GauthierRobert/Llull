/**
 * Arithmetic of drive sizing (PHY-23 TR-DRV-21 / 22): RMS over a sampled window, peaks, inertia matching and the margin against a limit.
 * Pure, IEEE double.
 */

import { elementAt } from '@lib/elementAt';

/**
 * RMS of `values` over `times` with trapezoid weights: sqrt(sum x_k^2 dt_k / sum dt_k), dt_k = half the two intervals around sample k.
 * Two samples at the same time (a step edge) are allowed: the zero-width interval between them weighs nothing.
 * @failure fewer than two samples or a zero-length window -> NaN (the caller refuses)
 */
export function rmsOver(times: readonly number[], values: readonly number[]): number {
  const n = Math.min(times.length, values.length);
  let [sum, span] = [0, 0];
  for (let k = 1; k < n; k++) {
    const h = elementAt(times, k) - elementAt(times, k - 1);
    const [a, b] = [elementAt(values, k - 1), elementAt(values, k)];
    sum += (h * (a * a + b * b)) / 2;
    span += h;
  }
  return span > 0 ? Math.sqrt(sum / span) : Number.NaN;
}

export const peakAbs = (values: readonly number[]): number => values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);

/**
 * Peak motor torque (N·m) to give a pure inertial load J_L the acceleration alpha_L through a reduction N (ideal, no losses):
 * T = alpha_L (J_m N + J_L / N); the minimum over N is at N = sqrt(J_L / J_m) with T = 2 alpha_L sqrt(J_m J_L).
 */
export const peakTorqueForInertialLoad = (motorInertia: number, loadInertia: number, loadAcceleration: number, ratio: number): number =>
  loadAcceleration * (motorInertia * ratio + loadInertia / ratio);

export const inertiaMatchedRatio = (motorInertia: number, loadInertia: number): number => Math.sqrt(loadInertia / motorInertia);

/** capacity / demand - 1: 0 at the limit, negative when the demand exceeds it; null when there is no demand to compare. */
export const marginOf = (capacity: number, demand: number): number | null => (demand > 0 ? capacity / demand - 1 : null);
