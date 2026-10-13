/** Angle wrapping with explicit ranges (radians). */

import { roundTo } from './compactNumber';

const TURN = 2 * Math.PI;

/** `angle` wrapped into [0, 2π). */
export function wrapAngle(angle: number): number {
  return ((angle % TURN) + TURN) % TURN;
}

/** `angle` wrapped to the nearest turn: [−π, π) (`angle − 2π·round(angle / 2π)`). */
export function wrapSignedAngle(angle: number): number {
  return angle - TURN * Math.round(angle / TURN);
}

/**
 * A CCW arc sweep: a non-positive `sweep` gains whole turns until it lies in (0, 2π] (zero is a full circle); a positive sweep, even beyond
 * 2π, is returned unchanged.
 */
export function positiveSweep(sweep: number): number {
  let result = sweep;
  while (result <= 0) result += TURN;
  return result;
}

/** Degrees to radians. */
export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Radians to degrees; with `decimals`, rounded to that many decimal places. */
export function toDegrees(radians: number, decimals?: number): number {
  const degrees = (radians * 180) / Math.PI;
  return decimals === undefined ? degrees : roundTo(degrees, decimals);
}

/** Angle in [0, π] between two vectors given their dot product of unit vectors (acos, clamped). */
export function angleFromCosine(cosine: number): number {
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

/**
 * A text direction that reads left-to-right / bottom-up: `angle` (radians) turned by π into (−π/2, π/2] when it points backwards. Dimension
 * values, contour and alignment labels.
 */
export function readableAngle(angle: number): number {
  const wrapped = wrapSignedAngle(angle);
  if (wrapped > Math.PI / 2 + 1e-9) return wrapped - Math.PI;
  if (wrapped <= -Math.PI / 2 + 1e-9) return wrapped + Math.PI;
  return wrapped;
}
