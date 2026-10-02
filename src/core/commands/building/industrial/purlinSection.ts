/**
 * purlinCheck: purlinSection.
 * @layer core/commands/building/industrial
 */

import { sectionProperties, type SteelProfile } from '../steel/profiles';
import { E_STEEL, lateralTorsionalReduction, sectionResistance } from './steelDesign';
import type { Verdict } from './purlinModel';

/** EN 1993-1-5 §4.4 plate reduction ρ for slenderness λp with the 0.055 (3 + ψ) term. */
function plateReduction(slenderness: number, psiTerm: number): number {
  return slenderness <= 0.673 ? 1 : Math.min(1, (slenderness - psiTerm) / slenderness ** 2);
}

interface Segment {
  readonly area: number;
  /** Distance of the segment centre above mid-depth, mm. */
  readonly y: number;
  /** Own second moment about its centre, mm⁴ (vertical segments only). */
  readonly inertia: number;
}

function sectionModulus(segments: readonly Segment[], top: number): number {
  const area = segments.reduce((sum, segment) => sum + segment.area, 0);
  const axis = segments.reduce((sum, segment) => sum + segment.area * segment.y, 0) / area;
  const inertia = segments.reduce(
    (sum, segment) => sum + segment.inertia + segment.area * (segment.y - axis) ** 2,
    0,
  );
  return inertia / (top - axis);
}

/**
 * Effective / gross section modulus of a cold-formed C in strong-axis bending (thin-walled model,
 * compression flange on top; symmetric so gravity and uplift share the ratio).
 * Flange: internal element, kσ = 4, bp = b - t (centreline flat width), ρ·bp split at the flange ends, extra 0.9 when λp > 0.673.
 * Web: ψ = -1, kσ = 23.9, compression zone h/2, ρ·hc split 0.4 / 0.6 (EN 1993-1-5 Tab. 4.1).
 * Lips fully effective (no distortional buckling χd); neutral axis shift not iterated.
 * @returns ratio <= 1 and the flange / web reduction factors
 */
export function effectiveModulusRatio(
  profile: SteelProfile,
  fy: number,
): { ratio: number; flangeRho: number; webRho: number } {
  const t = profile.tw;
  const epsilon = Math.sqrt(235 / fy);
  const web = profile.h - t;
  const flange = profile.b - t;
  const lip = Math.max(0, profile.lip - t / 2);
  const flangeSlenderness = flange / t / (28.4 * epsilon * Math.sqrt(4));
  const webSlenderness = web / t / (28.4 * epsilon * Math.sqrt(23.9));
  const flangeRho = plateReduction(flangeSlenderness, 0.22) * (flangeSlenderness > 0.673 ? 0.9 : 1);
  const webRho = plateReduction(webSlenderness, 0.11);
  const half = web / 2;
  const vertical = (length: number, y: number): Segment => ({
    area: t * length,
    y,
    inertia: (t * length ** 3) / 12,
  });
  const horizontal = (length: number, y: number): Segment => ({ area: t * length, y, inertia: 0 });
  const bottom = (): Segment[] => [horizontal(flange, -half), vertical(lip, -half + lip / 2)];
  const gross: Segment[] = [
    ...bottom(),
    horizontal(flange, half),
    vertical(lip, half - lip / 2),
    vertical(web, 0),
  ];
  const effectiveZone = (webRho * web) / 2;
  const upperPart = 0.4 * effectiveZone;
  const lowerPart = 0.6 * effectiveZone;
  const effective: Segment[] = [
    ...bottom(),
    horizontal(flangeRho * flange, half),
    vertical(lip, half - lip / 2),
    vertical(web / 2, -half / 2),
    vertical(upperPart, half - upperPart / 2),
    vertical(lowerPart, lowerPart / 2),
  ];
  const top = half + t / 2;
  return {
    ratio: Math.min(1, sectionModulus(effective, top) / sectionModulus(gross, top)),
    flangeRho,
    webRho,
  };
}

/** Design bending resistance, N·mm: Wpl fy for I, Weff fy for cold-formed C, Wel fy otherwise. */
function bendingResistance(profile: SteelProfile, fy: number): number {
  if (profile.shape === 'I') return sectionResistance(profile, fy).moment;
  const elastic = sectionProperties(profile).elasticModulus * fy;
  return profile.shape === 'C' ? elastic * effectiveModulusRatio(profile, fy).ratio : elastic;
}

/** χLT of the free flange: I sections by EN 1993-1-1 §6.3.2.3, cold-formed C by the simplified §10.1 value. */
export function freeFlangeReduction(profile: SteelProfile, fy: number, span: number): number {
  return profile.shape === 'I'
    ? lateralTorsionalReduction(profile, fy, span / 2)
    : span > 6000
      ? 0.6
      : 0.75;
}

/** Governing (highest utilisation) of a list of verdicts. */
export function governing(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce((best, verdict) =>
    verdict.utilisation > best.utilisation ? verdict : best,
  );
}

/** Simply supported member under uniform line loads (kN/m, perpendicular to the strong axis). */
export function beamVerdicts(
  profile: SteelProfile,
  fy: number,
  span: number,
  loads: {
    ultimate: number;
    ultimateLabel: string;
    serviceability: number;
    serviceabilityLabel: string;
    deflectionRatio: number;
    reduction: number;
    bendingLabel: string;
  },
): Verdict[] {
  const metres = span / 1000;
  const moment = (Math.max(0, loads.ultimate) * metres * metres) / 8;
  const shear = (Math.max(0, loads.ultimate) * metres) / 2;
  const momentResistance = (loads.reduction * bendingResistance(profile, fy)) / 1e6;
  const shearResistance = sectionResistance(profile, fy).shear / 1000;
  const inertia = sectionProperties(profile).inertia;
  const deflection =
    (5 * Math.max(0, loads.serviceability) * span ** 4) / (384 * E_STEEL * inertia);
  const limit = span / loads.deflectionRatio;
  return [
    {
      check: `${loads.bendingLabel} (χ ${loads.reduction.toFixed(2)})`,
      value: moment,
      limit: momentResistance,
      unit: 'kNm',
      utilisation: moment / momentResistance,
      combination: loads.ultimateLabel,
    },
    {
      check: 'shear V/Vpl,Rd',
      value: shear,
      limit: shearResistance,
      unit: 'kN',
      utilisation: shear / shearResistance,
      combination: loads.ultimateLabel,
    },
    {
      check: `deflection ≤ span/${loads.deflectionRatio}`,
      value: deflection,
      limit,
      unit: 'mm',
      utilisation: deflection / limit,
      combination: loads.serviceabilityLabel,
    },
  ];
}
