/**
 * Result rows of check_steel_members: one row per steel member, worst check first-class.
 * @layer domain-aec
 * @pure
 */

import type { MemberRole } from '@core/model/building';
import { round } from '../numeric';
import type { SteelBar } from './steelMemberBars';

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

/** Row of an analysed member: the check of highest utilisation governs. */
export function analysedRow(
  bar: SteelBar,
  lines: ReadonlyArray<CheckLine>,
  forces: Readonly<Record<string, number>> = {},
): MemberRow {
  const worst = lines.reduce<CheckLine | undefined>(
    (best, line) => (best === undefined || line.utilisation > best.utilisation ? line : best),
    undefined,
  );
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
