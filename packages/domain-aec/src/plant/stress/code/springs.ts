/** Variable spring hanger arithmetic (07 PST §5.8 / §5.10, FR-PST-13): cold load and load variability of a spring at its travel. */

/** Named default limit of the load variability (MSS SP-58 practice, grade B); 0.15 near rotating equipment. */
export const DEFAULT_MAX_VARIABILITY = 0.25;
export const ROTATING_EQUIPMENT_MAX_VARIABILITY = 0.15;

export interface SpringLoads {
  readonly coldLoadN: number;
  readonly variability: number;
}

/**
 * P_cold = P_hot + k d, V = |k d| / P_hot, with d the vertical travel from the cold to the hot position, positive upward: a pipe that rises
 * unloads a hanging spring, so its cold (installed) load is the larger.
 * @invariant a hot load of zero or less has no spring (variability is infinite)
 */
export function springLoads(hotLoadN: number, rateNPerMm: number, travelUpMm: number): SpringLoads {
  const change = rateNPerMm * travelUpMm;
  return { coldLoadN: hotLoadN + change, variability: hotLoadN > 0 ? Math.abs(change) / hotLoadN : Number.POSITIVE_INFINITY };
}

export interface SpringChoiceSize {
  readonly size: string;
  readonly series: string;
  readonly minN: number;
  readonly maxN: number;
  readonly rateNPerMm: number;
  readonly travelMm: number;
}

export type SpringChoice =
  | { readonly kind: 'size'; readonly size: SpringChoiceSize; readonly coldLoadN: number; readonly variability: number }
  | { readonly kind: 'none'; readonly reason: 'no-size' | 'variability'; readonly lowestVariability: number | null };

/**
 * The smallest size (smallest top of the load range, then lowest rate, then series and size name) of `sizes` whose load range holds `hotLoadN`, whose
 * travel holds |d| and whose variability is within `maxVariability` (§5.8 step 3).
 * @invariant a choice with no fit says why: no size covers load and travel (`no-size`), or those that do vary too much (`variability`, with the lowest value)
 */
export function pickSpring(sizes: readonly SpringChoiceSize[], hotLoadN: number, travelUpMm: number, maxVariability: number): SpringChoice {
  const covering = sizes.filter((size) => size.minN <= hotLoadN && hotLoadN <= size.maxN && Math.abs(travelUpMm) <= size.travelMm);
  if (covering.length === 0) return { kind: 'none', reason: 'no-size', lowestVariability: null };
  const scored = covering.map((size) => ({ size, ...springLoads(hotLoadN, size.rateNPerMm, travelUpMm) }));
  const fits = scored
    .filter((entry) => entry.variability <= maxVariability && entry.coldLoadN > 0)
    .sort(
      (a, b) =>
        a.size.maxN - b.size.maxN ||
        a.size.rateNPerMm - b.size.rateNPerMm ||
        a.size.series.localeCompare(b.size.series) ||
        a.size.size.localeCompare(b.size.size),
    );
  const best = fits[0];
  if (best !== undefined) return { kind: 'size', size: best.size, coldLoadN: best.coldLoadN, variability: best.variability };
  return { kind: 'none', reason: 'variability', lowestVariability: Math.min(...scored.map((entry) => entry.variability)) };
}
