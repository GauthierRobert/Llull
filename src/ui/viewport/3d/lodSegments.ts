/**
 * @layer ui/viewport/3d
 *
 * Segment count for curved THREE geometries (sphere, cylinder, cone, torus), picked once when the
 * geometry is memoized from the entity's size: small objects need far fewer segments, and a
 * static count avoids full three.js LOD objects (extra geometries + per-frame distance checks).
 *
 *   segments = clamp(8 + floor(log2(diag) * 4), 8, 64)    e.g. diag 4 → 16, 16 → 24, 64 → 32
 *
 * @pure
 */

/**
 * Radial segment count for a bounding-box diagonal `diag` (world units; clamped to ≥ 1e-6).
 * @returns integer in [8, 64]
 */
export function radialSegmentsForDiag(diag: number): number {
  const safeDiag = Math.max(diag, 1e-6);
  const raw = 8 + Math.floor(Math.log2(safeDiag) * 4);
  return Math.max(8, Math.min(64, raw));
}

/**
 * Size heuristic for a sphere's segment count: its diameter (the true bounding-box diagonal
 * would be diameter × √3).
 *
 * @pure
 */
export function sphereDiag(radius: number): number {
  return 2 * radius;
}

/**
 * Diagonal of a cylinder/cone bounding box (radius × height).
 * sqrt((2r)^2 + h^2)
 *
 * @pure
 */
export function cylinderDiag(radius: number, height: number): number {
  const d = 2 * radius;
  return Math.sqrt(d * d + height * height);
}

/**
 * Size heuristic for a torus's segment count: its outer diameter, 2 * (ringRadius + tubeRadius).
 *
 * @pure
 */
export function torusDiag(ringRadius: number, tubeRadius: number): number {
  return 2 * (ringRadius + tubeRadius);
}
