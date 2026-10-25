/** Defaults of a guard-rail derived from the access-rule rows of the active rulesets (06 STA §4: nothing is a literal). */

import { ruleById, type RulesetName } from '../rules/ruleTable';

export interface RailingDefaults {
  readonly heightMm: number;
  readonly toePlateMm: number;
  readonly kneeRails: number;
  /** Which row decided which value, for `data.defaults`. */
  readonly basis: string[];
}

/** Used when no ruleset gives a post spacing: ISO-GRD-POST-SPACING is grade C (not loaded), so this is a named default, never a gate. */
export const DEFAULT_POST_SPACING_MM = 1500;

const largest = (values: ReadonlyArray<readonly [number, string]>): readonly [number, string] =>
  values.reduce((best, value) => (value[0] > best[0] ? value : best));

/**
 * Height = the highest of the active rulesets' nominal (else minimum) top-rail height; toe plate = the highest minimum; knee rails = the fewest
 * for which the clear space between rails (top rail and toe plate included) is within the smallest limit of the active rulesets.
 */
export function railingDefaults(rulesets: ReadonlyArray<RulesetName>, railDepthMm: number): RailingDefaults {
  const iso = rulesets.includes('iso_14122');
  const osha = rulesets.includes('osha_1910');
  const tops: Array<readonly [number, string]> = [];
  const toes: Array<readonly [number, string]> = [];
  const gaps: Array<readonly [number, string]> = [];
  if (iso) {
    tops.push([ruleById('ISO-GRD-TOP').min ?? 0, 'ISO-GRD-TOP']);
    toes.push([ruleById('ISO-TOE-HEIGHT').min ?? 0, 'ISO-TOE-HEIGHT']);
    gaps.push([ruleById('ISO-GRD-GAP').max ?? Infinity, 'ISO-GRD-GAP']);
  }
  if (osha) {
    const top = ruleById('OSHA-GRD-TOP');
    tops.push([top.nominal ?? top.min ?? 0, 'OSHA-GRD-TOP']);
    toes.push([ruleById('OSHA-TOE-HEIGHT').min ?? 0, 'OSHA-TOE-HEIGHT']);
    gaps.push([ruleById('OSHA-GRD-MID').maxOpening ?? Infinity, 'OSHA-GRD-MID']);
  }
  const [heightMm, heightRow] = largest(tops);
  const [toePlateMm, toeRow] = largest(toes);
  const [gapLimit, gapRow] = gaps.reduce((best, value) => (value[0] < best[0] ? value : best));
  let kneeRails = 0;
  while (kneeRails < 10 && (heightMm - toePlateMm - (kneeRails + 1) * railDepthMm) / (kneeRails + 1) > gapLimit) kneeRails++;
  return {
    heightMm,
    toePlateMm,
    kneeRails,
    basis: [
      `height ${heightMm} mm (${heightRow})`,
      `toePlate ${toePlateMm} mm (${toeRow})`,
      `kneeRails ${kneeRails} (clear space <= ${gapLimit} mm, ${gapRow})`,
    ],
  };
}
