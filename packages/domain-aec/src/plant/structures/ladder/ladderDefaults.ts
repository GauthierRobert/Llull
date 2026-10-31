/** Values of a ladder taken from the access-rule rows of the requested rulesets (06 STA §5.1): nothing is a literal limit. */

import type { LadderFallProtection } from '@aec/building/types';
import { ruleById, type RulesetName } from '../rules/ruleTable';

/** OSHA 1910.28(b)(9): fixed ladders installed on or after this date need a ladder safety system or PFAS above the 24 ft threshold. */
export const OSHA_LADDER_RULE_DATE = '2018-11-19';
/** Date until which existing caged ladders are allowed (under a proposed repeal, see the flag of OSHA-LAD-FALLPROT-HEIGHT). */
export const OSHA_CAGE_RETROFIT_DATE = '2036-11-18';

const has = (rulesets: readonly RulesetName[], name: RulesetName): boolean => rulesets.includes(name);

/** Allowed pitch range, mm: [largest minimum, smallest maximum] of the requested rulesets. */
export function pitchRange(rulesets: readonly RulesetName[]): { min: number; max: number; basis: string } {
  const rows = [
    ...(has(rulesets, 'iso_14122') ? [ruleById('ISO-LAD-PITCH')] : []),
    ...(has(rulesets, 'osha_1910') ? [ruleById('OSHA-LAD-RUNG-PITCH')] : []),
  ];
  return {
    min: Math.max(...rows.map((row) => row.min ?? 0)),
    max: Math.min(...rows.map((row) => row.max ?? Infinity)),
    basis: rows.map((row) => row.id).join(' + '),
  };
}

export type PitchPlan = { ok: true; spaces: number; pitchMm: number } | { ok: false; reason: string };

/** Uniform pitch (§5.1): `spaces = ceil(H / pMax)`, `pitch = H / spaces`; infeasible when that pitch is below the allowed minimum. */
export function planPitch(heightMm: number, maxMm: number, minMm: number, basis: string): PitchPlan {
  const spaces = Math.max(1, Math.ceil(heightMm / maxMm - 1e-9));
  const pitchMm = heightMm / spaces;
  return pitchMm < minMm - 1e-6
    ? {
        ok: false,
        reason: `H = ${heightMm} mm: ${spaces} space(s) of at most ${maxMm} mm give ${pitchMm.toFixed(3)} mm, below the minimum ${minMm} mm (${basis})`,
      }
    : { ok: true, spaces, pitchMm };
}

export interface Defaulted<T> {
  readonly value: T;
  readonly basis: string;
}

const strictest = (rows: ReadonlyArray<{ id: string; min?: number }>): Defaulted<number> => {
  const best = rows.reduce((top, row) => ((row.min ?? 0) > (top.min ?? 0) ? row : top));
  return { value: best.min ?? 0, basis: best.id };
};

/** Clear width between the stiles, mm: the largest minimum of the requested rulesets. */
export const defaultClearWidthMm = (rulesets: readonly RulesetName[]): Defaulted<number> =>
  strictest([
    ...(has(rulesets, 'iso_14122') ? [ruleById('ISO-LAD-WIDTH')] : []),
    ...(has(rulesets, 'osha_1910') ? [ruleById('OSHA-LAD-CLEAR-WIDTH')] : []),
  ]);

/** Stile extension above the arrival level, mm: the largest minimum of the requested rulesets. */
export const defaultRailExtensionMm = (rulesets: readonly RulesetName[]): Defaulted<number> =>
  strictest([
    ...(has(rulesets, 'iso_14122') ? [ruleById('ISO-LAD-STILE-EXT')] : []),
    ...(has(rulesets, 'osha_1910') ? [ruleById('OSHA-LAD-RAIL-EXT')] : []),
  ]);

/** True when the ladder counts as installed on or after the OSHA date (an unknown date is read strictly). */
export const installedAfterRuleDate = (installedOn: string | undefined): boolean =>
  installedOn === undefined || installedOn >= OSHA_LADDER_RULE_DATE;

/**
 * Fall protection the requested rulesets call for: LSS above the OSHA threshold for a ladder installed from 2018-11-19, else a cage where ISO
 * (from its height) or OSHA (existing cage above 24 ft) allows one, else none.
 */
export function defaultFallProtection(
  heightMm: number,
  installedOn: string | undefined,
  rulesets: readonly RulesetName[],
): Defaulted<LadderFallProtection> {
  const iso = has(rulesets, 'iso_14122') && heightMm >= (ruleById('ISO-LAD-FALLPROT-HEIGHT').min ?? Infinity);
  const osha = has(rulesets, 'osha_1910') && heightMm > (ruleById('OSHA-LAD-FALLPROT-HEIGHT').maxWithout ?? Infinity);
  if (osha && installedAfterRuleDate(installedOn)) return { value: 'ladder_safety_system', basis: 'OSHA-LAD-FALLPROT-HEIGHT' };
  if (iso || osha) return { value: 'cage', basis: iso ? 'ISO-LAD-FALLPROT-HEIGHT' : 'OSHA-LAD-FALLPROT-HEIGHT' };
  return { value: 'none', basis: 'no requested ruleset requires fall protection at this height' };
}

/** Cage values in mm from the ISO cage rows (named defaults whatever the rulesets: only ISO 14122-4 gives cage dimensions). */
export const defaultCageMm = (): { startHeight: number; hoopSpacing: number; diameter: number; bars: number } => ({
  startHeight: ruleById('ISO-LAD-CAGE-START').min ?? 0,
  hoopSpacing: ruleById('ISO-LAD-CAGE-HOOP').max ?? 0,
  diameter: ruleById('ISO-LAD-CAGE-DIAM').min ?? 0,
  bars: DEFAULT_CAGE_BARS,
});

/** Vertical bars of a cage: no rule row gives a number, this is a named geometric default. */
export const DEFAULT_CAGE_BARS = 5;

/**
 * Landing heights above the base (mm): equal sections no longer than the interval of the requested ruleset (OSHA cage 50 ft, A; OSHA LSS / PFAS
 * rest 150 ft, B). Only OSHA gives an interval; ISO 14122-4 flight height is grade C and is not applied.
 */
export function defaultLandingsMm(heightMm: number, fallProtection: LadderFallProtection, rulesets: readonly RulesetName[]): number[] {
  if (!has(rulesets, 'osha_1910') || fallProtection === 'none') return [];
  const interval = ruleById(fallProtection === 'cage' ? 'OSHA-LAD-CAGE-LANDING' : 'OSHA-LAD-LSS-REST').max ?? Infinity;
  const sections = Math.ceil(heightMm / interval - 1e-9);
  return Array.from({ length: Math.max(0, sections - 1) }, (_, index) => (heightMm * (index + 1)) / sections);
}
