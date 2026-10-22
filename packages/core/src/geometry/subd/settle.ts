/**
 * Settling of semi-sharp creases for the exact paths (patches, limit masks, code export): after ceil(max finite sharpness) refinement steps a
 * Uniform crease has decayed to zero, so the masks and patch rules that only know infinite sharpness describe the same surface as the level
 * mesh. Pure.
 */

import { type Cage, subdivide } from '../subdivision';
import { SHARP_MAX } from './sharpness';

/** Largest number of settling steps (a sharpness above it keeps a small residual that the exact paths treat as smooth). */
const MAX_SETTLE_LEVELS = 3;

/** Refinement steps after which every finite sharpness of `cage` has decayed (0 when there is none). */
export function settleLevels(cage: Pick<Cage, 'edgeSharpness' | 'vertexSharpness'>): number {
  const finite = [...(cage.edgeSharpness ?? []).map((e) => e.s), ...(cage.vertexSharpness ?? []).map((c) => c.s)].filter(
    (s) => s > 0 && s < SHARP_MAX,
  );
  return finite.length === 0 ? 0 : Math.min(MAX_SETTLE_LEVELS, Math.ceil(Math.max(...finite)));
}

/** `cage` refined `settleLevels(cage)` times (the same cage when nothing is semi-sharp); original vertex indices are kept. */
export function settledCage(cage: Cage): { cage: Cage; levels: number } {
  const levels = settleLevels(cage);
  return { cage: levels === 0 ? cage : subdivide(cage, levels), levels };
}
