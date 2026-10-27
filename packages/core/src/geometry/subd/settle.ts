/**
 * Settling of semi-sharp creases: after ceil(max finite sharpness) refinement steps every finite sharpness has decayed to zero (Uniform and Chaikin
 * both lower the largest by at least 1 per step), so masks and patch rules that only know infinite sharpness describe the surface `refineOnce` defines.
 * `fullSettleLevels` is that exact count and is what the cage fit uses. `settleLevels` is the same count CAPPED at MAX_SETTLE_LEVELS for the exact
 * paths with a size budget (limit patches / B-spline export, `cageVertexLimits`, the surface evaluator, code export): above the cap a residual
 * sharpness is still on the edges at the settle level and those paths treat it as an infinite crease, which is not what the level mesh does (they
 * differ for sharpness above 3). Pure.
 */

import { type Cage, subdivide } from '../subdivision';
import { SHARP_MAX } from './sharpness';

/** Largest number of settling steps of the budgeted exact paths (a sharpness above it keeps a residual at the settle level, which they treat as infinite). */
const MAX_SETTLE_LEVELS = 3;

/** Refinement steps after which every finite sharpness of `cage` has decayed, not capped (0 when there is none). */
export function fullSettleLevels(cage: Pick<Cage, 'edgeSharpness' | 'vertexSharpness'>): number {
  const finite = [...(cage.edgeSharpness ?? []).map((e) => e.s), ...(cage.vertexSharpness ?? []).map((c) => c.s)].filter(
    (s) => s > 0 && s < SHARP_MAX,
  );
  return finite.length === 0 ? 0 : Math.ceil(Math.max(...finite));
}

/** `fullSettleLevels` capped at MAX_SETTLE_LEVELS: the settling of the budgeted exact paths. */
export function settleLevels(cage: Pick<Cage, 'edgeSharpness' | 'vertexSharpness'>): number {
  return Math.min(MAX_SETTLE_LEVELS, fullSettleLevels(cage));
}

/** `cage` refined `settleLevels(cage)` times (the same cage when nothing is semi-sharp); original vertex indices are kept. */
export function settledCage(cage: Cage): { cage: Cage; levels: number } {
  const levels = settleLevels(cage);
  return { cage: levels === 0 ? cage : subdivide(cage, levels), levels };
}
