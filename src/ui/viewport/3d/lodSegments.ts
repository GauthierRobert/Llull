// Static segment count for curved geometries from the entity size (no three.js LOD objects / per-frame checks):
// segments = clamp(8 + floor(log2(diag) * 4), 8, 64), e.g. diag 4 → 16, 16 → 24, 64 → 32.
import { clamp } from '@lib/clamp';

/** @returns integer in [8, 64]; diag clamped to ≥ 1e-6 */
export function radialSegmentsForDiag(diag: number): number {
  const safeDiag = Math.max(diag, 1e-6);
  const raw = 8 + Math.floor(Math.log2(safeDiag) * 4);
  return clamp(raw, 8, 64);
}

/** Diameter (not the true diagonal, diameter × √3). */
export function sphereDiag(radius: number): number {
  return 2 * radius;
}

/** sqrt((2r)² + h²). */
export function cylinderDiag(radius: number, height: number): number {
  const d = 2 * radius;
  return Math.sqrt(d * d + height * height);
}

/** Outer diameter. */
export function torusDiag(ringRadius: number, tubeRadius: number): number {
  return 2 * (ringRadius + tubeRadius);
}
