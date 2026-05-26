/**
 * @layer ui/viewport/3d
 *
 * LOD segment-count helper for curved THREE geometries (sphere, cylinder, cone, torus).
 *
 * Rationale: a sphere at radius=0.5 world unit needs far fewer radial segments
 * than one at radius=50 world units for the same visual quality. Rather than
 * building full three.js LOD objects (which require separate geometry instances
 * and camera distance tracking every frame), we pick a static segment count at
 * geometry memo time from the entity's bounding-box diagonal. This is cheaper,
 * sufficient for our entity counts, and avoids per-frame LOD evaluation cost.
 *
 * Formula:  segments = clamp(8 + floor(log2(diag) * 4), 8, 64)
 *   diag ≤ 1  → 8   segments (tiny object, save triangles)
 *   diag = 4  → 16  segments
 *   diag = 16 → 24  segments
 *   diag = 64 → 32  segments
 *   diag ≥ huge → capped at 64
 *
 * @pure — no side effects, only arithmetic.
 */

/**
 * Compute radial segment count for curved geometry based on bounding-box diagonal.
 *
 * @param diag - The longest diagonal of the entity's axis-aligned bounding box (world units).
 *               Must be positive; clamps to a minimum of 1e-6 internally.
 * @returns Integer segment count in [8, 64].
 */
export function radialSegmentsForDiag(diag: number): number {
  const safeDiag = Math.max(diag, 1e-6);
  const raw = 8 + Math.floor(Math.log2(safeDiag) * 4);
  return Math.max(8, Math.min(64, raw));
}

/**
 * Diagonal of a sphere's bounding box = 2 * radius * sqrt(3).
 * Simplified to 2 * radius * 1.732 ≈ diameter * 1.732.
 * For segment purposes we can use `2 * radius` (diameter) — good enough heuristic.
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
 * Diagonal of a torus bounding box.
 * Outer diameter = 2*(ringRadius + tubeRadius) in both X and Y.
 * Height in Z = 2*tubeRadius.
 * sqrt(outerDiam^2 + outerDiam^2 + (2*tubeRadius)^2) — use outer diameter as heuristic.
 *
 * @pure
 */
export function torusDiag(ringRadius: number, tubeRadius: number): number {
  return 2 * (ringRadius + tubeRadius);
}
