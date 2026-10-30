/** Ramp of a deformation region (01 DEF §5.1): w(z) goes 0 → 1 over [start, end] along the frame axis. */

import type { DeformRegion } from '../../model/deform';

export interface RampValue {
  /** Ramp value in [0, 1]. */
  readonly w: number;
  /** dw/dz (per document unit). */
  readonly d1: number;
  /** d²w/dz². */
  readonly d2: number;
}

const ZERO: RampValue = { w: 0, d1: 0, d2: 0 };
const ONE: RampValue = { w: 1, d1: 0, d2: 0 };

/**
 * Ramp at local height `z`: 0 below the start; past the end 1 (rigid); inside, `linear` clamp(t) or `smooth` 3t² − 2t³
 * with t = (z − start) / (end − start). `none` is a step at the start (stretch). An `infinite` region is the unclamped linear ramp w = t on the whole axis.
 */
export function rampAt(region: DeformRegion, z: number): RampValue {
  const length = region.end - region.start;
  const t = (z - region.start) / length;
  if (region.infinite === true) return { w: t, d1: 1 / length, d2: 0 };
  if (t <= 0) return ZERO;
  if (t >= 1) return ONE;
  if (region.falloff === 'none') return ONE;
  if (region.falloff === 'linear') return { w: t, d1: 1 / length, d2: 0 };
  return { w: t * t * (3 - 2 * t), d1: (6 * t * (1 - t)) / length, d2: (6 - 12 * t) / (length * length) };
}
