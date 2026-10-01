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

export interface BucklingCheck {
  readonly utilisation: number;
  readonly chiMajor: number;
  readonly chiMinor: number;
}

/**
 * Member stability under compression N (N, ≥ 0) + major-axis bending M (N·mm):
 * N/(χy Npl) + kyy M/Mrd and N/(χz Npl) + 0.6 kyy M/Mrd, kyy = Cm (1 + min(λ̄y − 0.2, 0.8) n),
 * Cm = 0.9 (sway). Lateral-torsional buckling is not checked (restrained compression flange).
 * @invariant lengths in mm
 */
export function memberBuckling(
  profile: SteelProfile,
  fy: number,
  compression: number,
  moment: number,
  lengths: { readonly major: number; readonly minor: number },
): BucklingCheck {
  const section = sectionProperties(profile);
  const resistance = sectionResistance(profile, fy);
  const slenderness = (inertia: number, length: number): number =>
    Math.sqrt(resistance.axial / ((Math.PI ** 2 * E_STEEL * inertia) / length ** 2));
  const { major, minor } = curves(profile);
  const lambdaMajor = slenderness(section.inertia, lengths.major);
  const chiMajor = bucklingReduction(lambdaMajor, major);
  const chiMinor = bucklingReduction(slenderness(section.minorInertia, lengths.minor), minor);
  const axial = Math.max(0, compression);
  const n = axial / ((chiMajor * resistance.axial) / GAMMA_M1);
  const kyy = 0.9 * (1 + Math.min(Math.max(lambdaMajor - 0.2, 0), 0.8) * n);
  const bending = Math.abs(moment) / (resistance.moment / GAMMA_M1);
  return {
    utilisation: Math.max(
      n + kyy * bending,
      axial / ((chiMinor * resistance.axial) / GAMMA_M1) + 0.6 * kyy * bending,
    ),
    chiMajor,
    chiMinor,
  };
}
