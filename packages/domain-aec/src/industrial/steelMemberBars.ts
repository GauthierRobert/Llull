/**
 * Steel members of a document as analysis bars: absolute axis ends in mm, catalogue section, yield
 * strength and the structural kind (column / beam / brace) that decides which check applies.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { BaseFixity, BuildingModel, JointFixity, MemberRole } from '@core/model/building';
import { fromMm, getBuilding } from '../model';
import { findProfile, sectionProperties, type SteelProfile } from '../steel/profiles';
import { yieldStrength } from './steelDesign';

/** m/s², converts kg to kN. */
export const GRAVITY = 9.80665;

type BarKind = 'column' | 'beam' | 'brace' | 'skipped';

export interface SteelBar {
  readonly id: string;
  readonly mark: string;
  readonly role: MemberRole;
  readonly profileName: string;
  readonly profile: SteelProfile | null;
  readonly levelId: string;
  readonly fy: number;
  /** Absolute axis end points, mm. */
  readonly start: Vec3;
  readonly end: Vec3;
  /** Axis length, mm. */
  readonly length: number;
  readonly kind: BarKind;
  /** Why a `skipped` bar is not analysed. */
  readonly skipReason: string | undefined;
  /** Section rotation about the axis, radians (decides which axis a frame plane bends). */
  readonly roll: number;
  /** Beam joints at start / end (pinned unless declared rigid). */
  readonly startJoint: JointFixity;
  readonly endJoint: JointFixity;
  /** Column base: the member's own `baseFixity`, else its base plate's, else pinned. */
  readonly baseFixity: BaseFixity;
  /** Fixity of the column's base plate, undefined without a plate. */
  readonly plateFixity: BaseFixity | undefined;
}

/** Document-unit → mm conversion and level elevations of a building. */
export interface ModelUnits {
  readonly building: BuildingModel;
  /** Document units → mm. */
  readonly toMm: (value: number) => number;
  readonly elevationMm: (levelId: string) => number;
}

export function modelUnits(doc: CadDocument): ModelUnits {
  const building = getBuilding(doc);
  const unit = fromMm(doc, 1);
  return {
    building,
    toMm: (value) => value / unit,
    elevationMm: (levelId) => (building.levels[levelId]?.elevation ?? 0) / unit,
  };
}

const POINTER: Readonly<Partial<Record<MemberRole, string>>> = {
  rafter: 'check_portal_frames',
  purlin: 'check_purlins',
  rail: 'check_purlins',
  crane: 'check_crane_runways',
};

/** Slope limits of the classification: |dz| / length. */
const VERTICAL_RATIO = 0.95;
const HORIZONTAL_RATIO = 0.1;

function classify(
  role: MemberRole,
  profile: SteelProfile | null,
  profileName: string,
  length: number,
  dz: number,
): { kind: BarKind; reason: string | undefined } {
  const skip = (reason: string): { kind: BarKind; reason: string } => ({ kind: 'skipped', reason });
  if (profile === null) {
    return skip(`profile '${profileName}' is not in the steel catalogue (list_steel_profiles)`);
  }
  if (!(length > 1)) return skip('member length is zero');
  const pointer = POINTER[role];
  if (pointer !== undefined) {
    return skip(
      `role '${role}' carries roof, wind or crane loads that check_steel_members does not derive — use ${pointer}`,
    );
  }
  const ratio = Math.abs(dz) / length;
  if (role === 'column') {
    return ratio >= VERTICAL_RATIO
      ? { kind: 'column', reason: undefined }
      : skip('column is inclined more than 18° from the vertical');
  }
  if (role === 'beam') {
    return ratio <= HORIZONTAL_RATIO
      ? { kind: 'beam', reason: undefined }
      : skip('beam slopes more than 5.7° (floor beams are taken as horizontal)');
  }
  return ratio >= HORIZONTAL_RATIO
    ? { kind: 'brace', reason: undefined }
    : skip('horizontal brace (plan bracing) is not covered');
}

/** Every steel member of the document, in document order, with absolute mm geometry. */
export function collectSteelBars(doc: CadDocument): SteelBar[] {
  const { building, toMm, elevationMm } = modelUnits(doc);
  const bars: SteelBar[] = [];
  const plateFixities = new Map<string, BaseFixity>();
  for (const element of Object.values(building.elements)) {
    if (element.category === 'plate')
      plateFixities.set(element.memberId, element.fixity ?? 'pinned');
  }
  for (const id of building.elementOrder) {
    const element = building.elements[id];
    if (element?.category !== 'member') continue;
    const base = elevationMm(element.levelId);
    const point = (value: readonly number[]): Vec3 => [
      toMm(value[0] ?? 0),
      toMm(value[1] ?? 0),
      base + toMm(value[2] ?? 0),
    ];
    const start = point(element.start);
    const end = point(element.end);
    const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    const profile = findProfile(element.profile) ?? null;
    const { kind, reason } = classify(
      element.role,
      profile,
      element.profile,
      length,
      end[2] - start[2],
    );
    bars.push({
      id: element.id,
      mark: element.mark,
      role: element.role,
      profileName: profile?.name ?? element.profile,
      profile,
      levelId: element.levelId,
      fy: yieldStrength(element.material),
      start,
      end,
      length,
      kind,
      skipReason: reason,
      roll: element.roll,
      startJoint: element.startJoint ?? 'pinned',
      endJoint: element.endJoint ?? 'pinned',
      baseFixity: element.baseFixity ?? plateFixities.get(element.id) ?? 'pinned',
      plateFixity: plateFixities.get(element.id),
    });
  }
  return bars;
}

/** Self weight of a profile, kN/m. */
export const selfWeightPerMetre = (profile: SteelProfile): number =>
  (profile.massPerMetre * GRAVITY) / 1000;

/** Top of steel of a horizontal beam (axis mid-height + half the section depth), mm. */
export const topOfSteel = (bar: SteelBar): number =>
  (bar.start[2] + bar.end[2]) / 2 + (bar.profile?.h ?? 0) / 2;

const sectionCache = new WeakMap<SteelProfile, ReturnType<typeof sectionProperties>>();

/** Section properties of a catalogue profile (memoised per profile object). */
export function sectionOf(profile: SteelProfile): ReturnType<typeof sectionProperties> {
  const cached = sectionCache.get(profile);
  if (cached) return cached;
  const computed = sectionProperties(profile);
  sectionCache.set(profile, computed);
  return computed;
}

/**
 * Class of the section in pure compression (EN 1993-1-1 Tab. 5.2); null when the shape is not
 * covered (angles, channels, cold-formed C).
 */
export function compressionClass(profile: SteelProfile, fy: number): 1 | 2 | 3 | 4 | null {
  const epsilon = Math.sqrt(235 / fy);
  const byLimits = (ratio: number, limits: readonly [number, number, number]): 1 | 2 | 3 | 4 =>
    ratio <= limits[0] ? 1 : ratio <= limits[1] ? 2 : ratio <= limits[2] ? 3 : 4;
  switch (profile.shape) {
    case 'I':
      return Math.max(
        byLimits((profile.h - 2 * profile.tf) / profile.tw, [
          33 * epsilon,
          38 * epsilon,
          42 * epsilon,
        ]),
        byLimits((profile.b - profile.tw) / 2 / profile.tf, [
          9 * epsilon,
          10 * epsilon,
          14 * epsilon,
        ]),
      ) as 1 | 2 | 3 | 4;
    case 'CHS':
      return byLimits(profile.h / profile.tw, [
        50 * epsilon ** 2,
        70 * epsilon ** 2,
        90 * epsilon ** 2,
      ]);
    case 'SHS':
    case 'RHS':
      return byLimits((Math.max(profile.h, profile.b) - 3 * profile.tw) / profile.tw, [
        33 * epsilon,
        38 * epsilon,
        42 * epsilon,
      ]);
    default:
      return null;
  }
}

/** Means of the groups of `values` whose neighbours (sorted) lie within `tolerance`: the levels they stand at. */
export const clusterMeans = (values: ReadonlyArray<number>, tolerance: number): number[] => {
  const groups: number[][] = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && value - (last[last.length - 1] as number) <= tolerance) last.push(value);
    else groups.push([value]);
  }
  return groups.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
};

/** Index of the value closest to `target` (the first on a tie). */
export const nearestIndex = (values: ReadonlyArray<number>, target: number): number =>
  values.reduce(
    (best, value, index) =>
      Math.abs(value - target) < Math.abs((values[best] as number) - target) ? index : best,
    0,
  );

/** Shapes the beam check covers (principal-axis bending about the depth axis, no torsion). */
export const isBeamShape = (profile: SteelProfile): boolean =>
  profile.shape === 'I' ||
  profile.shape === 'SHS' ||
  profile.shape === 'RHS' ||
  profile.shape === 'CHS';

/** Radius of gyration about the weak axis, mm. */
export function minorRadius(profile: SteelProfile): number {
  const section = sectionOf(profile);
  return Math.sqrt(Math.min(section.inertia, section.minorInertia) / section.area);
}
