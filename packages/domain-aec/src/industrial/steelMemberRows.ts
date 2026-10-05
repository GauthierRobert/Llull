/**
 * Result rows of check_steel_members: one row per steel member, worst check first-class, and the
 * gates that turn a bar the checks do not cover into its skipped row.
 * @layer domain-aec
 * @pure
 */

import type { MemberRole } from '@core/model/building';
import type { SteelProfile } from '../steel/profiles';
import { round } from '../numeric';
import { highestUtilisation } from './utilisation';
import { sectionResistance } from './steelDesign';
import { compressionClass, isBeamShape, type SteelBar } from './steelMemberBars';

/** Combination name of the gravity checks. */
export const ULS_COMBINATION = 'ULS 1.35 G + 1.5 Q';

/** A length in mm as metres, e.g. "3.00". */
export const metres = (value: number): string => (value / 1000).toFixed(2);

/** One verification of a member: utilisation 1.0 = at resistance. */
export interface CheckLine {
  readonly name: string;
  readonly utilisation: number;
  /** Combination / load case the utilisation belongs to. */
  readonly combination: string;
  readonly detail: string;
}

export interface MemberRow {
  readonly id: string;
  readonly mark: string;
  readonly role: MemberRole;
  readonly profile: string;
  readonly levelId: string;
  /** False for members the command cannot analyse. */
  readonly analysed: boolean;
  /** Name of the governing check, or 'not analysed'. */
  readonly check: string;
  readonly utilisation: number;
  readonly ok: boolean;
  readonly governing: string;
  readonly detail: string;
  /** Every check run on the member. */
  readonly checks: ReadonlyArray<{ name: string; utilisation: number }>;
  /** Design actions: NEd, VEd (kN), MEd (kNm), deflection (mm) where they apply. */
  readonly forces: Readonly<Record<string, number>>;
}

const base = (bar: SteelBar): Pick<MemberRow, 'id' | 'mark' | 'role' | 'profile' | 'levelId'> => ({
  id: bar.id,
  mark: bar.mark,
  role: bar.role,
  profile: bar.profileName,
  levelId: bar.levelId,
});

/** Row of a member that cannot be analysed. */
export function skippedRow(bar: SteelBar, reason: string): MemberRow {
  return {
    ...base(bar),
    analysed: false,
    check: 'not analysed',
    utilisation: 0,
    ok: false,
    governing: '—',
    detail: reason,
    checks: [],
    forces: {},
  };
}

/**
 * Row of an analysed member: the check of highest utilisation governs.
 * @param candidates the member's checks; `undefined` entries (checks that did not apply) are dropped
 */
export function analysedRow(
  bar: SteelBar,
  candidates: ReadonlyArray<CheckLine | undefined>,
  forces: Readonly<Record<string, number>> = {},
): MemberRow {
  const lines = candidates.filter((line): line is CheckLine => line !== undefined);
  const worst = highestUtilisation(lines);
  if (worst === undefined) return skippedRow(bar, 'no check applies to this member');
  const utilisation = round(worst.utilisation, 3);
  return {
    ...base(bar),
    analysed: true,
    check: worst.name,
    utilisation,
    ok: worst.utilisation <= 1,
    governing: worst.combination,
    detail: worst.detail,
    checks: lines.map((line) => ({ name: line.name, utilisation: round(line.utilisation, 3) })),
    forces: Object.fromEntries(
      Object.entries(forces).map(([key, value]) => [key, round(value, 3)]),
    ),
  };
}

/** Row of a bar whose catalogue profile is unknown. */
export const noProfileRow = (bar: SteelBar): MemberRow =>
  skippedRow(bar, bar.skipReason ?? 'profile not in the catalogue');

interface Skipped {
  readonly skipped: MemberRow;
}

const skip = (bar: SteelBar, reason: string): Skipped => ({ skipped: skippedRow(bar, reason) });

/** Profile and resistance of a bar bent about its depth axis, or the row of a bar not covered (shape, class 4). */
export function beamSection(
  bar: SteelBar,
): { profile: SteelProfile; resistance: ReturnType<typeof sectionResistance> } | Skipped {
  const { profile } = bar;
  if (!profile) return { skipped: noProfileRow(bar) };
  if (!isBeamShape(profile)) {
    return skip(
      bar,
      `${profile.name}: ${profile.shape} sections as beams (torsion from eccentric load, principal axes) are not covered`,
    );
  }
  const resistance = sectionResistance(profile, bar.fy);
  if (resistance.sectionClass === 4) {
    return skip(
      bar,
      `${profile.name} is class 4 in bending at fy ${bar.fy}: effective-section resistance is not covered`,
    );
  }
  return { profile, resistance };
}

/** Profile, compression class and resistance of a column, or the row of a bar not covered (shape, class 4). */
export function columnSection(bar: SteelBar):
  | {
      profile: SteelProfile;
      sectionClass: 1 | 2 | 3;
      resistance: ReturnType<typeof sectionResistance>;
    }
  | Skipped {
  const { profile } = bar;
  if (!profile) return { skipped: noProfileRow(bar) };
  const sectionClass = compressionClass(profile, bar.fy);
  if (sectionClass === null) {
    return skip(
      bar,
      `${profile.name}: ${profile.shape} sections in compression (torsional-flexural buckling) are not covered`,
    );
  }
  if (sectionClass === 4) {
    return skip(
      bar,
      `${profile.name} is class 4 in compression at fy ${bar.fy}: effective-section resistance is not covered`,
    );
  }
  return { profile, sectionClass, resistance: sectionResistance(profile, bar.fy) };
}
