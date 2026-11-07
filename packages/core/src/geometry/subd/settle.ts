/**
 * Settling of semi-sharp creases: after ceil(max finite sharpness) refinement steps every finite sharpness has decayed to zero (Uniform and Chaikin
 * both lower the largest by at least 1 per step), so masks and patch rules that only know infinite sharpness describe the surface `refineOnce` defines.
 * `settleLevels` is that exact count, UNCAPPED, for every path (limit patches / B-spline export, `cageVertexLimits`, the surface evaluator, code
 * export, the cage fit): one surface definition. The cost is the refined quad count, (sum of face sides) x 4^(levels-1), so a cage is bounded by
 * SETTLE_QUAD_BUDGET and the commands that write sharpness refuse a cage over it by name (`settleBudgetProblem`, DIR_SHARPNESS_BUDGET). A document that
 * got past them (hand-edited, loaded) is clamped to the largest settling within the budget: its sharpness left over is read as infinite, the one
 * place the paths differ from the level mesh, and `check_subdivision` reports it. Pure.
 */

import { type Cage, subdivide } from '../subdivision';
import { SHARP_MAX } from './sharpness';

type SettleSource = Pick<Cage, 'edgeSharpness' | 'vertexSharpness'>;

/** Most quads the settled cage may have (the evaluator's per-level quad budget is above it). A cube: sharpness up to 7; a 400-face cage: about 4. */
const SETTLE_QUAD_BUDGET = 100_000;

/** Refinement steps after which every finite sharpness of `cage` has decayed (0 when there is none). */
export function fullSettleLevels(cage: SettleSource): number {
  const finite = [...(cage.edgeSharpness ?? []).map((e) => e.s), ...(cage.vertexSharpness ?? []).map((c) => c.s)].filter(
    (s) => s > 0 && s < SHARP_MAX,
  );
  return finite.length === 0 ? 0 : Math.ceil(Math.max(...finite));
}

/** Quads of `cage` refined `levels` times (>= 1): every face, an n-gon included, becomes quads at the first step. */
const refinedQuads = (cage: Pick<Cage, 'faces'>, levels: number): number =>
  cage.faces.reduce((total, face) => total + face.length, 0) * 4 ** (levels - 1);

/** Settling of `cage` (0 when nothing is semi-sharp): `fullSettleLevels`, lowered until the settled cage is within SETTLE_QUAD_BUDGET (never below 1). */
export function settleLevels(cage: SettleSource & Pick<Cage, 'faces'>): number {
  let levels = fullSettleLevels(cage);
  while (levels > 1 && refinedQuads(cage, levels) > SETTLE_QUAD_BUDGET) levels--;
  return levels;
}

/** Why `cage` cannot be settled exactly (its largest finite sharpness needs more levels than the budget allows; null when it can). */
export function settleBudgetProblem(cage: SettleSource & Pick<Cage, 'faces'>): string | null {
  const full = fullSettleLevels(cage);
  const fits = settleLevels(cage);
  if (full <= fits) return null;
  const largest = Math.max(
    ...[...(cage.edgeSharpness ?? []), ...(cage.vertexSharpness ?? [])].map((e) => e.s).filter((s) => s > 0 && s < SHARP_MAX),
  );
  return (
    `sharpness ${largest} needs ${full} settling levels, ${refinedQuads(cage, full)} quads (budget ${SETTLE_QUAD_BUDGET}); ` +
    `lower the sharpness to at most ${fits}, use fewer cage faces, or use ${SHARP_MAX} (infinitely sharp)`
  );
}

/** `cage` refined `settleLevels(cage)` times (the same cage when nothing is semi-sharp); original vertex indices are kept. */
export function settledCage(cage: Cage): { cage: Cage; levels: number } {
  const levels = settleLevels(cage);
  return { cage: levels === 0 ? cage : subdivide(cage, levels), levels };
}
