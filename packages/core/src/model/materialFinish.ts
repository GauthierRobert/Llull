/** Procedural surface finishes of a material (Material.finish). */

export const FINISH_PATTERNS = ['carbon_twill', 'carbon_plain', 'brushed', 'knurl', 'checker'] as const;

export type FinishPattern = (typeof FINISH_PATTERNS)[number];

/**
 * Tileable procedural finish: one texture tile spans `scale` document units, box-projected onto the part (glTF export + viewport use the
 * same maps).
 * @invariant scale > 0; normalStrength in [0, 2]; clearcoat in [0, 1]
 */
export interface MaterialFinish {
  readonly pattern: FinishPattern;
  readonly scale: number;
  /** Secondary colour (alternate tows, checker squares); default derived from `color`. */
  readonly color2?: string;
  /** Normal-map strength (relief depth), default 1. */
  readonly normalStrength?: number;
  /** Clear lacquer layer over the finish (0 = none, 1 = full gloss coat), default 0. */
  readonly clearcoat?: number;
}
