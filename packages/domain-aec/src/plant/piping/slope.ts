/**
 * Slope maths (02 RTE §5.6): a declared slope as a ratio, the direction and length of a sloped leg from its horizontal direction and plan length,
 * and the fall of a leg read back from its geometry. Pure; angles in degrees, lengths in document units.
 * @invariant a slope of a leg is a property of its direction: `fallOf(slopedLeg(...))` returns the declared ratio
 */

import type { Vec3 } from '@core/model/vectors';
import type { Slope } from '@aec/plant/types';
import { len3, scale3 } from '@lib/vec3';

/** Largest slope accepted for a leg: 100 % (45 degrees); steeper is a riser, not a slope. */
export const MAX_SLOPE_RATIO = 1;

/** The slope as drop per unit of plan length (a positive number; the direction is `fall`). */
export function slopeRatio(slope: Pick<Slope, 'value' | 'unit'>): number {
  switch (slope.unit) {
    case 'percent':
      return slope.value / 100;
    case 'ratio':
      return slope.value;
    case 'deg':
      return Math.tan((slope.value * Math.PI) / 180);
  }
}

/** True when `slope` is a usable declaration: finite, > 0 and not steeper than 45 degrees. */
export const validSlope = (slope: Pick<Slope, 'value' | 'unit'>): boolean => {
  const ratio = slopeRatio(slope);
  return Number.isFinite(ratio) && ratio > 0 && ratio <= MAX_SLOPE_RATIO + 1e-12;
};

export interface SlopedLeg {
  /** Unit direction of the leg. */
  readonly direction: Vec3;
  /** Length along the leg: planLength x sqrt(1 + s^2). */
  readonly length: number;
  /** Vertical change along the leg, positive = descending: planLength x s. */
  readonly dropMm: number;
}

/** The leg of plan length `planLength` along the horizontal unit vector `plan`, falling or rising by `slope`. */
export function slopedLeg(plan: Vec3, planLength: number, slope: Slope): SlopedLeg {
  const ratio = slopeRatio(slope);
  const sign = slope.fall ? 1 : -1;
  const vector: Vec3 = [plan[0] * planLength, plan[1] * planLength, -sign * ratio * planLength];
  const length = len3(vector);
  return { direction: scale3(vector, 1 / length), length, dropMm: sign * ratio * planLength };
}

/** Geometry of one leg read back from its unit direction: plan length, drop (positive = descends along the flow) and the angle below horizontal. */
export function legFall(direction: Vec3, length: number): { planLengthMm: number; dropMm: number; slopeDeg: number } {
  const drop = -direction[2] * length;
  return {
    planLengthMm: Math.hypot(direction[0], direction[1]) * length,
    dropMm: drop,
    slopeDeg: (Math.asin(Math.max(-1, Math.min(1, -direction[2]))) * 180) / Math.PI,
  };
}

/** True when the leg is neither horizontal nor vertical (a sloped leg), within 1e-9 of the unit direction. */
export const isSloped = (direction: Vec3): boolean => Math.abs(direction[2]) > 1e-9 && Math.hypot(direction[0], direction[1]) > 1e-9;
