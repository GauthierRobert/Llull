/**
 * Structural steel strength by grade and governing thickness, EN 1993-1-1 Table 3.1 (simplified: two thickness bands). Source grade B:
 * values taken from secondary extracts of the standard, the standard text was not read (docs/readiness/10-result-integrity/validation/sources.md S2).
 */

import type { SteelProfile } from '../../steel/profiles';

export type SteelRefusalCode = 'STL_GRADE_UNKNOWN' | 'STL_THICKNESS_OUT_OF_RANGE';

export interface SteelRefusal {
  readonly code: SteelRefusalCode;
  readonly message: string;
}

export interface SteelStrength {
  /** Yield strength, N/mm². */
  readonly fy: number;
  /** Ultimate strength, N/mm². */
  readonly fu: number;
  /** Governing thickness the band was chosen for, mm. */
  readonly thicknessMm: number;
  /** Rule that produced the value, shown in result rows. */
  readonly rule: string;
}

interface GradeBand {
  readonly fy: number;
  readonly fu: number;
}

interface GradeRow {
  /** t ≤ 40 mm. */
  readonly upTo40: GradeBand;
  /** 40 mm < t ≤ 80 mm. */
  readonly upTo80: GradeBand;
  /** Product standard the Table 3.1 row is taken from. */
  readonly source: string;
}

/** EN 1993-1-1:2005 Table 3.1, nominal values of fy and fu, N/mm² (one row per nominal grade). */
const GRADES: Readonly<Record<string, GradeRow>> = {
  S235: { upTo40: { fy: 235, fu: 360 }, upTo80: { fy: 215, fu: 360 }, source: 'EN 10025-2 S 235' },
  S275: { upTo40: { fy: 275, fu: 430 }, upTo80: { fy: 255, fu: 410 }, source: 'EN 10025-2 S 275' },
  S355: { upTo40: { fy: 355, fu: 510 }, upTo80: { fy: 335, fu: 470 }, source: 'EN 10025-2 S 355' },
  S420: { upTo40: { fy: 420, fu: 520 }, upTo80: { fy: 390, fu: 520 }, source: 'EN 10025-3 S 420 N/NL' },
  S450: { upTo40: { fy: 440, fu: 550 }, upTo80: { fy: 410, fu: 550 }, source: 'EN 10025-2 S 450' },
  S460: { upTo40: { fy: 460, fu: 540 }, upTo80: { fy: 430, fu: 540 }, source: 'EN 10025-3 S 460 N/NL' },
};

const KNOWN_GRADES = Object.keys(GRADES).join(', ');
const GRADE_GRAMMAR = /^S\s*(\d{3})(?:\s*(?:JR|J0|J2|K2|NL|N|ML|M|QL|Q|\+\s*(?:AR|N|M|QT)))*$/;

const refuse = (code: SteelRefusalCode, message: string): SteelRefusal => ({ code, message: `${code}: ${message}` });

/**
 * Yield and ultimate strength of a grade at a governing thickness.
 * @invariant grammar S + 3 digits + optional quality suffix, whitespace and case tolerated; nothing is guessed
 * @failure STL_GRADE_UNKNOWN — grade text outside the grammar or not in S235/S275/S355/S420/S450/S460
 * @failure STL_THICKNESS_OUT_OF_RANGE — thickness not in (0, 80] mm
 */
export function steelStrength(grade: string, thicknessMm: number): SteelStrength | SteelRefusal {
  const match = GRADE_GRAMMAR.exec(grade.trim().toUpperCase());
  const row = match ? GRADES[`S${match[1]}`] : undefined;
  if (!row)
    return refuse(
      'STL_GRADE_UNKNOWN',
      `steel grade '${grade}' is not recognised (accepted: ${KNOWN_GRADES}, with optional quality suffix)`,
    );
  if (!(thicknessMm > 0 && thicknessMm <= 80)) {
    return refuse(
      'STL_THICKNESS_OUT_OF_RANGE',
      `governing thickness ${thicknessMm} mm of grade '${grade}' is outside 0 < t ≤ 80 mm (EN 1993-1-1 Table 3.1)`,
    );
  }
  const thin = thicknessMm <= 40;
  const band = thin ? row.upTo40 : row.upTo80;
  return { fy: band.fy, fu: band.fu, thicknessMm, rule: `EN 1993-1-1 Tab. 3.1 (${row.source}), ${thin ? 't ≤ 40 mm' : '40 < t ≤ 80 mm'}` };
}

export const isSteelRefusal = (value: SteelStrength | SteelRefusal): value is SteelRefusal => 'code' in value;

/** Row fragment naming the strength used: "fy 355 N/mm², t 12 mm, EN 1993-1-1 Tab. 3.1 (…), t ≤ 40 mm". */
export const strengthNote = (strength: SteelStrength): string => `fy ${strength.fy} N/mm², t ${strength.thicknessMm} mm, ${strength.rule}`;

/** Governing thickness of a catalogue section: the thicker of flange and web (wall thickness for hollow and flat sections), mm. */
export const governingThickness = (profile: SteelProfile): number => Math.max(profile.tf, profile.tw);

/** Strength of a member's material at the governing thickness of its section. */
export const memberStrength = (material: string, profile: SteelProfile): SteelStrength | SteelRefusal =>
  steelStrength(material, governingThickness(profile));
