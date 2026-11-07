/** Hatch of a `region` entity (2D area bounded by loops). */

/** Fill patterns: `lines` = parallel lines at `angle` (45° = ANSI31), `cross` = lines at `angle` and `angle + 90°`, `solid` = filled. */
export const REGION_HATCH_PATTERNS = ['solid', 'lines', 'cross'] as const;
export type RegionHatchPattern = (typeof REGION_HATCH_PATTERNS)[number];

/** Hatch of a region; the pattern is drawn in the entity `color`. */
export interface RegionHatch {
  pattern: RegionHatchPattern;
  /** Line angle in radians, counter-clockwise from +X of the entity plane (ignored by `solid`). */
  angle: number;
  /** Distance between pattern lines in document units, > 0 (ignored by `solid`). */
  spacing: number;
}
