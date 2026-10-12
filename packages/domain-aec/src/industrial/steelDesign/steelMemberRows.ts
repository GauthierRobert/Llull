/**
 * Result rows of check_steel_members: one row per steel member, worst check first-class, and the
 * gates that turn a bar the checks do not cover into its skipped row.
 * @layer domain-aec
 * @pure
 */

import type { MemberRole } from '@core/model/building';
import type { SteelProfile } from '../../steel/profiles';
import { round } from '../../shared/numeric';
import { highestUtilisation } from '../common/utilisation';
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

/** Plastic shear check line (§6.2.6); `subject` prefixes the detail, forces in kN. */
export const shearCheckLine = (
  subject: string,
  combination: string,
  utilisation: number,
  shearEdKn: number,
  shearRdKn: number,
): CheckLine => ({
  name: 'shear (§6.2.6)',
  utilisation,
  combination,
  detail: `${subject}: V ${shearEdKn.toFixed(1)} kN ≤ Vpl,Rd ${shearRdKn.toFixed(0)} kN`,
});

/** SLS deflection check line against `limit` (mm); `label` names the limit, e.g. "L/250". */
export const deflectionCheckLine = (
  subject: string,
  label: string,
  deflection: number,
  limit: number,
): CheckLine => ({
  name: `deflection (${label})`,
  utilisation: deflection / limit,
  combination: 'SLS G + Q',
  detail: `${subject}: δ ${deflection.toFixed(1)} mm ≤ ${label} = ${limit.toFixed(1)} mm`,
});

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
function beamSection(
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

/** Row built by `build` from the section of a beam bar, or the skipped row when it is not covered. */
export function withBeamSection(
  bar: SteelBar,
  build: (section: {
    profile: SteelProfile;
    resistance: ReturnType<typeof sectionResistance>;
  }) => MemberRow,
): MemberRow {
  const gate = beamSection(bar);
  return 'skipped' in gate ? gate.skipped : build(gate);
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
