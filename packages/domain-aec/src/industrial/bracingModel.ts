/**
 * bracingCheck: bracingModel.
 * @layer core/commands/building
 */

import type { SteelMemberElement } from '@core/model/building';
import { sectionProperties, type SteelProfile } from '../steel/profiles';
import { bucklingReduction, E_STEEL } from './steelDesign';
import { CRANE_FACTORS, craneActions } from './frameModel';
import { bufferForce, GAMMA_BUFFER } from './runwayCheck';

/** ULS factor on the crane drive force HL (permanent-type variable crane action, groups 1 and 5). */
const GAMMA_CRANE = 1.35;

/** Bridge span (mm) when only one runway line is found. */
export const DEFAULT_CRANE_SPAN = 20000;

/** Crane longitudinal design force (kN) acting at rail level on the wall that carries one runway. */
export interface CraneWallForce {
  /** 1.35 · HL,i (group 1/5 drive force of one rail), kN. */
  readonly driveGroup1: number;
  /** γ · HB,1 / nr (group 7 buffer force of one rail, accidental γ = 1.0), kN. */
  readonly bufferGroup7: number;
  readonly design: number;
  readonly governing: 'group 1' | 'group 7';
}

/**
 * Longitudinal crane force per runway line: max(1.35 HL,i, γ HB,1/nr).
 * @param spanMm bridge span between the rails
 */
export function craneWallForce(
  capacityTonnes: number,
  spanMm: number,
  craneSelfWeight: number | undefined,
  travelSpeed: number,
  bufferStiffness: number,
): CraneWallForce {
  const actions = craneActions(capacityTonnes, spanMm, {
    ...(craneSelfWeight !== undefined ? { craneSelfWeight } : {}),
  });
  const driveGroup1 = (GAMMA_CRANE * actions.group1.longitudinal) / 1000;
  const bufferGroup7 =
    (GAMMA_BUFFER * bufferForce(actions.selfWeight, travelSpeed, bufferStiffness)) /
    CRANE_FACTORS.rails /
    1000;
  return {
    driveGroup1,
    bufferGroup7,
    design: Math.max(driveGroup1, bufferGroup7),
    governing: bufferGroup7 > driveGroup1 ? 'group 7' : 'group 1',
  };
}

/** EN 1990 partial factor for variable (wind) actions. */
export const GAMMA_Q = 1.5;

/** EN 1990 6.10 permanent action factor for the equivalent stabilising force. */
export const GAMMA_G = 1.35;

/** EN 1991-1-4 whole gable (frame): windward pressure 0.8 + leeward suction 0.5. */
export const CP_GABLE = 0.8 + 0.5;

/** Gable post on one wall: net pressure cpe + cpi = 0.8 + 0.2 (EN 1991-1-4). */
export const CP_POST = 0.8 + 0.2;

/** EN 1993-1-1 §5.3.3 bracing equivalent force ratio (simplified 1/200). */
export const STABILITY_RATIO = 1 / 200;

/** Utilisation reported when a required member is missing (always a failure). */
export const NO_MEMBER_UTILISATION = 99;

/** Eaves purlin sits within this of the wall line in x (lift of the purlin off the rafter), mm. */
export const EAVES_X_TOLERANCE = 200;

/** Eaves purlin sits within this of the eaves level in z, mm. */
export const EAVES_Z_TOLERANCE = 400;

/** Position tolerance, mm. */
export const TOLERANCE = 1;

export interface BracingRow {
  readonly group: string;
  readonly elementId: string;
  /** Every element the row covers (both diagonals of an X). */
  readonly elementIds: readonly string[];
  readonly mark: string;
  readonly kind: 'diagonal' | 'strut' | 'gable-post';
  /** kN: diagonal tension, strut compression, post end reaction. */
  readonly force: number;
  /** kN: Npl,Rd, χ·Npl,Rd or Vpl,Rd. */
  readonly resistance: number;
  /** kNm: gable posts only (else 0). */
  readonly moment: number;
  /** kNm: gable posts only (else 0). */
  readonly momentResistance: number;
  readonly utilisation: number;
  readonly check: string;
}

export type Point = readonly [number, number, number];

export interface Located {
  readonly member: SteelMemberElement;
  readonly profile: SteelProfile;
  readonly start: Point;
  readonly end: Point;
}

export const round = (value: number, digits = 2): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

export const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE;

/** Flexural buckling imperfection factor about the minor axis (EN 1993-1-1 Tab. 6.1/6.2). */
function minorImperfection(profile: SteelProfile): number {
  if (profile.shape === 'I') return profile.h / profile.b > 1.2 ? 0.34 : 0.49;
  if (profile.shape === 'C') return 0.34;
  return profile.shape === 'SHS' || profile.shape === 'RHS' || profile.shape === 'CHS'
    ? 0.21
    : 0.49;
}

/** Design buckling resistance χ·A·fy (N) about the minor axis for a buckling length (mm). */
export function bucklingResistance(profile: SteelProfile, fy: number, length: number): number {
  const section = sectionProperties(profile);
  const npl = section.area * fy;
  const critical = (Math.PI ** 2 * E_STEEL * section.minorInertia) / length ** 2;
  return bucklingReduction(Math.sqrt(npl / critical), minorImperfection(profile)) * npl;
}

export interface Panel {
  readonly group: string;
  readonly roof: boolean;
  readonly bay: string;
  readonly braces: Located[];
}
