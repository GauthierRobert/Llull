/**
 * EN 1993 resistances used by the frame checks: material, bolts, cross-sections and members
 * (flexural buckling with the §6.3.3 interaction, method 2 simplified).
 * @layer core/commands/building/industrial
 * @pure
 */

import { sectionProperties, type SteelProfile } from '../steel/profiles';

export const E_STEEL = 210000; // N/mm²
const GAMMA_M1 = 1.0;
const GAMMA_M2 = 1.25;
const BOLT_FUB = 800; // grade 8.8, N/mm²
/** Tensile stress areas of metric bolts, mm² (ISO 898-1). */
const STRESS_AREA: Readonly<Record<number, number>> = {
  12: 84.3,
  16: 157,
  20: 245,
  22: 303,
  24: 353,
  27: 459,
  30: 561,
  36: 817,
};

/** Yield strength from a grade name ("S355" → 355 N/mm²); 355 when unknown. */
export function yieldStrength(grade: string): number {
  const value = Number(/S\s*(\d{3})/i.exec(grade)?.[1]);
  return Number.isFinite(value) && value > 0 ? value : 355;
}

/** Design resistances of one grade 8.8 bolt (EN 1993-1-8 Tab. 3.4), N. */
export function boltResistance(diameterMm: number): { tension: number; shear: number } {
  const nominal = Object.keys(STRESS_AREA)
    .map(Number)
    .reduce((best, size) =>
      Math.abs(size - diameterMm) < Math.abs(best - diameterMm) ? size : best,
    );
  const area = STRESS_AREA[nominal] as number;
  return {
    tension: (0.9 * BOLT_FUB * area) / GAMMA_M2,
    shear: (0.6 * BOLT_FUB * area) / GAMMA_M2,
  };
}

/**
 * Cross-section resistances (EN 1993-1-1 §6.2, γM0 = 1): Npl, Mpl (class 1–2) or Mel (class 3),
 * Vpl with Av ≈ h·tw; classification of I-sections in bending (Tab. 5.2), other shapes class 1.
 * Section properties from the outline (no root radii, ≈ 4–5 % conservative).
 */
export function sectionResistance(
  profile: SteelProfile,
  fy: number,
): { axial: number; moment: number; shear: number; sectionClass: 1 | 2 | 3 | 4 } {
  const section = sectionProperties(profile);
  const epsilon = Math.sqrt(235 / fy);
  let sectionClass: 1 | 2 | 3 | 4 = 1;
  if (profile.shape === 'I') {
    const flange = (profile.b - profile.tw) / 2 / profile.tf / epsilon;
    const web = (profile.h - 2 * profile.tf) / profile.tw / epsilon;
    const flangeClass = flange <= 9 ? 1 : flange <= 10 ? 2 : flange <= 14 ? 3 : 4;
    const webClass = web <= 72 ? 1 : web <= 83 ? 2 : web <= 124 ? 3 : 4;
    sectionClass = Math.max(flangeClass, webClass) as 1 | 2 | 3 | 4;
  }
  const shearArea = profile.shape === 'I' ? profile.h * profile.tw : section.area / 2;
  return {
    axial: section.area * fy,
    moment: (sectionClass <= 2 ? section.plasticModulus : section.elasticModulus) * fy,
    shear: (shearArea * fy) / Math.sqrt(3),
    sectionClass,
  };
}

/** Flexural buckling reduction χ (EN 1993-1-1 §6.3.1.2) for a non-dimensional slenderness. */
export function bucklingReduction(slenderness: number, imperfection: number): number {
  if (slenderness <= 0.2) return 1;
  const phi = 0.5 * (1 + imperfection * (slenderness - 0.2) + slenderness ** 2);
  return Math.min(1, 1 / (phi + Math.sqrt(phi * phi - slenderness ** 2)));
}

/** Imperfection factors of the buckling curves (Tab. 6.1/6.2): rolled I, hot-finished hollow. */
function curves(profile: SteelProfile): { major: number; minor: number } {
  if (profile.shape === 'I') {
    return profile.h / profile.b > 1.2
      ? { major: 0.21, minor: 0.34 }
      : { major: 0.34, minor: 0.49 };
  }
  if (profile.shape === 'SHS' || profile.shape === 'RHS' || profile.shape === 'CHS') {
    return { major: 0.21, minor: 0.21 };
  }
  return { major: 0.49, minor: 0.49 };
}

const G_STEEL = 81000; // N/mm²

/**
 * Elastic critical moment of a doubly-symmetric I-section (load at the shear centre, k = kw = 1):
 * Mcr = C1 π² E Iz / L² · √(Iw/Iz + L² G It / (π² E Iz)); It, Iw from the plate dimensions.
 * @returns N·mm; Infinity for shapes not susceptible to lateral-torsional buckling
 */
export function criticalMoment(profile: SteelProfile, length: number, c1 = 1): number {
  if (profile.shape !== 'I') return Infinity;
  const minor = sectionProperties(profile).minorInertia;
  const torsion =
    (2 * profile.b * profile.tf ** 3 + (profile.h - 2 * profile.tf) * profile.tw ** 3) / 3;
  const warping = (minor * (profile.h - profile.tf) ** 2) / 4;
  const euler = (Math.PI ** 2 * E_STEEL * minor) / length ** 2;
  return c1 * euler * Math.sqrt(warping / minor + (G_STEEL * torsion) / euler);
}

/**
 * χLT for rolled I-sections (§6.3.2.3: λ̄LT,0 = 0.4, β = 0.75; curve b for h/b ≤ 2, c above).
 * `momentFactor` scales Mcr (C1 and load-position effects).
 */
export function lateralTorsionalReduction(
  profile: SteelProfile,
  fy: number,
  length: number,
  momentFactor = 1,
): number {
  const mcr = criticalMoment(profile, length, momentFactor);
  if (!Number.isFinite(mcr)) return 1;
  const slenderness = Math.sqrt(sectionResistance(profile, fy).moment / mcr);
  if (slenderness <= 0.4) return 1;
  const imperfection = profile.h / profile.b <= 2 ? 0.34 : 0.49;
  const phi = 0.5 * (1 + imperfection * (slenderness - 0.4) + 0.75 * slenderness ** 2);
  return Math.min(
    1,
    1 / slenderness ** 2,
    1 / (phi + Math.sqrt(phi * phi - 0.75 * slenderness ** 2)),
  );
}

export interface BucklingCheck {
  readonly utilisation: number;
  readonly chiMajor: number;
  readonly chiMinor: number;
  readonly chiLateralTorsional: number;
}

/**
 * Member stability under compression N (N, ≥ 0) + major-axis bending M (N·mm), EN 1993-1-1
 * §6.3.3 method 2 (Annex B), Cm = CmLT = 0.9:
 * N/(χy Npl) + kyy M/(χLT Mrd) and N/(χz Npl) + kzy M/(χLT Mrd); kzy per Tab. B.2 for
 * torsionally susceptible I-sections (0.6 kyy and χLT = 1 for the other shapes).
 * @invariant lengths in mm; lateralTorsional = spacing of compression-flange restraints
 */
export function memberBuckling(
  profile: SteelProfile,
  fy: number,
  compression: number,
  moment: number,
  lengths: {
    readonly major: number;
    readonly minor: number;
    readonly lateralTorsional?: number;
  },
): BucklingCheck {
  const section = sectionProperties(profile);
  const resistance = sectionResistance(profile, fy);
  const slenderness = (inertia: number, length: number): number =>
    Math.sqrt(resistance.axial / ((Math.PI ** 2 * E_STEEL * inertia) / length ** 2));
  const { major, minor } = curves(profile);
  const lambdaMajor = slenderness(section.inertia, lengths.major);
  const lambdaMinor = slenderness(section.minorInertia, lengths.minor);
  const chiMajor = bucklingReduction(lambdaMajor, major);
  const chiMinor = bucklingReduction(lambdaMinor, minor);
  const chiLateralTorsional = lateralTorsionalReduction(
    profile,
    fy,
    lengths.lateralTorsional ?? lengths.minor,
  );
  const axial = Math.max(0, compression);
  const n = axial / ((chiMajor * resistance.axial) / GAMMA_M1);
  const nMinor = axial / ((chiMinor * resistance.axial) / GAMMA_M1);
  const plastic = resistance.sectionClass <= 2;
  // Annex B Tab. B.1 — class 1–2: Cm (1 + (λ̄ − 0.2) n) ≤ Cm (1 + 0.8 n);
  // class 3: Cm (1 + 0.6 λ̄ n) ≤ Cm (1 + 0.6 n).
  const kyy = plastic
    ? 0.9 * (1 + Math.min(Math.max(lambdaMajor - 0.2, 0), 0.8) * n)
    : 0.9 * (1 + 0.6 * Math.min(lambdaMajor, 1) * n);
  // Tab. B.2 (CmLT = 0.9): kzy = 1 − c λ̄z nz / (CmLT − 0.25), λ̄z clamped to 1; c = 0.1 / 0.05.
  const factor = plastic ? 0.1 : 0.05;
  const kzy =
    profile.shape !== 'I'
      ? 0.6 * kyy
      : plastic && lambdaMinor < 0.4
        ? Math.min(0.6 + lambdaMinor, 1 - (factor * lambdaMinor * nMinor) / 0.65)
        : Math.max(
            1 - (factor * Math.min(lambdaMinor, 1) * nMinor) / 0.65,
            1 - (factor * nMinor) / 0.65,
          );
  const bending = Math.abs(moment) / ((chiLateralTorsional * resistance.moment) / GAMMA_M1);
  return {
    utilisation: Math.max(n + kyy * bending, nMinor + kzy * bending),
    chiMajor,
    chiMinor,
    chiLateralTorsional,
  };
}
