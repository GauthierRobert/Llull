/**
 * Section behaviour of a member bent in the vertical plane of a moment frame: which principal axis
 * the plane bends (from the roll), weak-axis resistance and the §6.3.3 interaction for it, and the
 * moment resistance reduced by high shear (§6.2.8).
 * @layer domain-aec
 * @pure
 */

import type { SteelProfile } from '../steel/profiles';
import { eulerForce, memberBuckling, sectionResistance } from './steelDesign';
import type { FrameDirection } from './steelFrameDetect';
import { sectionOf } from './steelMemberBars';

type BendingAxis = 'strong' | 'weak';

const ALIGNMENT = (5 * Math.PI) / 180;

/** |cos| of the angle between the section depth axis of a vertical column and the frame's in-plane direction. */
const depthAlignment = (roll: number, direction: FrameDirection): number =>
  Math.abs(direction === 'Y' ? Math.sin(roll) : Math.cos(roll));

/**
 * Axis a vertical column bends about in a frame plane (depth points along +X at roll 0, +Y at π/2).
 * @returns null when the roll lies more than 5° from both principal directions
 */
export function columnBendingAxis(
  profile: SteelProfile,
  roll: number,
  direction: FrameDirection,
): BendingAxis | null {
  if (profile.shape === 'SHS' || profile.shape === 'CHS') return 'strong';
  const alignment = depthAlignment(roll, direction);
  if (alignment >= Math.cos(ALIGNMENT)) return 'strong';
  return alignment <= Math.sin(ALIGNMENT) ? 'weak' : null;
}

/** Second moment of area for bending in the frame plane, mm⁴ (interpolated between the axes). */
export function inPlaneInertia(
  profile: SteelProfile,
  roll: number,
  direction: FrameDirection,
): number {
  const section = sectionOf(profile);
  const weight = depthAlignment(roll, direction) ** 2;
  return section.inertia * weight + section.minorInertia * (1 - weight);
}

/** Weak-axis moment (N·mm) and shear (N) resistances. */
export function weakAxisResistance(
  profile: SteelProfile,
  fy: number,
): { moment: number; shear: number } {
  const section = sectionOf(profile);
  const resistance = sectionResistance(profile, fy);
  const elastic = section.minorInertia / (profile.b / 2);
  const plastic =
    profile.shape === 'I'
      ? (profile.tf * profile.b ** 2) / 2 + ((profile.h - 2 * profile.tf) * profile.tw ** 2) / 4
      : elastic * (section.plasticModulus / section.elasticModulus);
  const shearArea = profile.shape === 'I' ? 2 * profile.b * profile.tf : section.area / 2;
  return {
    moment: (resistance.sectionClass <= 2 ? plastic : elastic) * fy,
    shear: (shearArea * fy) / Math.sqrt(3),
  };
}

/**
 * Minor-axis bending with compression, EN 1993-1-1 §6.3.3 Annex B Tab. B.1 (kzz, kyz = 0.6 / 0.8 kzz),
 * Cmz = 0.9, no lateral-torsional buckling.
 * @param compression N (≥ 0); moment N·mm about the minor axis; length mm (both axes)
 */
export function weakAxisBuckling(
  profile: SteelProfile,
  fy: number,
  compression: number,
  moment: number,
  length: number,
): { utilisation: number; chi: number } {
  const resistance = sectionResistance(profile, fy);
  const section = sectionOf(profile);
  const { chiMajor, chiMinor } = memberBuckling(profile, fy, compression, 0, {
    major: length,
    minor: length,
  });
  const lambda = Math.sqrt(resistance.axial / eulerForce(section.minorInertia, length));
  const axial = Math.max(0, compression);
  const nMinor = axial / (chiMinor * resistance.axial);
  const nMajor = axial / (chiMajor * resistance.axial);
  const plastic = resistance.sectionClass <= 2;
  const kzz = plastic
    ? profile.shape === 'I'
      ? 0.9 * Math.min(1 + (2 * lambda - 0.6) * nMinor, 1 + 1.4 * nMinor)
      : 0.9 * Math.min(1 + (lambda - 0.6) * nMinor, 1 + 0.8 * nMinor)
    : 0.9 * Math.min(1 + 0.6 * lambda * nMinor, 1 + 0.6 * nMinor);
  const kyz = (plastic ? 0.6 : 0.8) * kzz;
  const bending = Math.abs(moment) / weakAxisResistance(profile, fy).moment;
  return {
    utilisation: Math.max(nMinor + kzz * bending, nMajor + kyz * bending),
    chi: Math.min(chiMajor, chiMinor),
  };
}

/**
 * Major-axis moment resistance (N·mm) at a section carrying shear `shear` (kN): Mc,Rd, reduced
 * with ρ = (2V/Vpl,Rd − 1)² when V > 0.5 Vpl,Rd (EN 1993-1-1 §6.2.8).
 */
export function shearReducedMoment(
  profile: SteelProfile,
  fy: number,
  shear: number,
): { moment: number; reduced: boolean } {
  const resistance = sectionResistance(profile, fy);
  const shearResistance = resistance.shear / 1000;
  if (!(shear > 0.5 * shearResistance)) return { moment: resistance.moment, reduced: false };
  const rho = ((2 * shear) / shearResistance - 1) ** 2;
  if (profile.shape === 'I' && resistance.sectionClass <= 2) {
    const web = (profile.h - 2 * profile.tf) * profile.tw;
    return {
      moment: (sectionOf(profile).plasticModulus - (rho * web ** 2) / (4 * profile.tw)) * fy,
      reduced: true,
    };
  }
  return { moment: resistance.moment * (1 - rho), reduced: true };
}
