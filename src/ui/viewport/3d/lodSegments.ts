// Static segment count for curved geometries from the entity size (no three.js LOD objects / per-frame checks):
// segments = clamp(48 + floor(log2(diag) * 8), 48, 128), e.g. diag ≤ 1 → 48, 4 → 64, 16 → 80, 64 → 96.
// The floor is what a round part needs to read as round up close (a 16-gon silhouette reads as a faceted prism); the size term keeps
// large parts smooth where their silhouette spans the screen. A sphere at the floor is ~2.3k triangles.
import { clamp } from '@lib/clamp';

export const MIN_RADIAL_SEGMENTS = 48;
export const MAX_RADIAL_SEGMENTS = 128;

/** @returns integer in [MIN_RADIAL_SEGMENTS, MAX_RADIAL_SEGMENTS]; diag clamped to ≥ 1e-6 */
export function radialSegmentsForDiag(diag: number): number {
  const safeDiag = Math.max(diag, 1e-6);
  const raw = MIN_RADIAL_SEGMENTS + Math.floor(Math.log2(safeDiag) * 8);
  return clamp(raw, MIN_RADIAL_SEGMENTS, MAX_RADIAL_SEGMENTS);
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
