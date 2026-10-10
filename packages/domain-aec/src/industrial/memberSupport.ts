/**
 * @layer domain-aec
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import type {
  BaseFixity,
  BuildingModel,
  JointFixity,
  MemberRole,
  SteelMemberElement,
} from '@core/model/building';
import { z } from '@core/commands/schema';
import { elementsOf, getBuilding, highestIndex, nextElementId, toMm, withElement } from '../model';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { distance3 } from '@lib/vec3';
import { findProfile, type SteelProfile } from '../steel/profiles';

const ROLE_MARK: Readonly<Record<MemberRole, string>> = {
  column: 'SC',
  rafter: 'RF',
  beam: 'SB',
  brace: 'BR',
  purlin: 'PU',
  rail: 'SR',
  crane: 'CB',
};

export const MEMBER_ROLES: ReadonlyArray<MemberRole> = [
  'column',
  'rafter',
  'beam',
  'brace',
  'purlin',
  'rail',
  'crane',
];

/** Next mark for a member role, e.g. "SC4", "PU12". */
export function nextMemberMark(building: BuildingModel, role: MemberRole): string {
  const prefix = ROLE_MARK[role];
  const marks = Object.values(building.elements)
    .filter((element) => element.category === 'member')
    .map((element) => element.mark);
  return `${prefix}${highestIndex(marks, prefix) + 1}`;
}

/** A steel member of a level with its catalogue profile (if known) and endpoints in mm. */
interface MemberInMm {
  readonly member: SteelMemberElement;
  readonly profile: SteelProfile | undefined;
  readonly start: readonly [number, number, number];
  readonly end: readonly [number, number, number];
}

/** Steel members of `levelId` with endpoints converted to mm. */
export function levelMembersInMm(doc: CadDocument, levelId: string): MemberInMm[] {
  const toPointMm = (point: readonly number[]): readonly [number, number, number] => [
    toMm(doc, point[0] ?? 0),
    toMm(doc, point[1] ?? 0),
    toMm(doc, point[2] ?? 0),
  ];
  return elementsOf(getBuilding(doc), 'member')
    .filter((member) => member.levelId === levelId)
    .map((member) => ({
      member,
      profile: findProfile(member.profile),
      start: toPointMm(member.start),
      end: toPointMm(member.end),
    }));
}

/** Accepts [x, y, z] or [x, y] (z = 0); null when malformed. */
export function toVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) return null;
  if (!value.every((n) => isFiniteNumber(n))) return null;
  return [value[0] as number, value[1] as number, (value[2] as number | undefined) ?? 0];
}

export function profileSummary(profile: SteelProfile): string {
  return `${profile.name} (${profile.massPerMetre} kg/m)`;
}

export interface MemberSpec {
  role: MemberRole;
  profile: string;
  start: Vec3;
  end: Vec3;
  roll?: number | undefined;
  material?: string | undefined;
  note?: string | undefined;
  startJoint?: JointFixity | undefined;
  endJoint?: JointFixity | undefined;
  baseFixity?: BaseFixity | undefined;
}

export const jointFixitySchema = z.enum(['pinned', 'rigid']);
export const baseFixitySchema = z.enum(['pinned', 'fixed']);

/**
 * Joint / base fixity only make sense on the member that owns them.
 * @returns the reason, or null when the combination is valid
 */
export function fixityProblem(
  role: MemberRole,
  fixity: Pick<MemberSpec, 'startJoint' | 'endJoint' | 'baseFixity'>,
): string | null {
  if ((fixity.startJoint !== undefined || fixity.endJoint !== undefined) && role !== 'beam')
    return `startJoint / endJoint apply to beams (role is '${role}')`;
  if (fixity.baseFixity !== undefined && role !== 'column')
    return `baseFixity applies to columns (role is '${role}')`;
  return null;
}

/**
 * Adds members to `building` on `levelId` (no regeneration).
 * @failure unknown profile / zero length -> reason string
 */
export function appendMembers(
  building: BuildingModel,
  levelId: string,
  specs: ReadonlyArray<MemberSpec>,
): { building: BuildingModel; ids: string[] } | { reason: string } {
  let next = building;
  const ids: string[] = [];
  for (const spec of specs) {
    const profile = findProfile(spec.profile);
    if (!profile)
      return { reason: `unknown steel profile '${spec.profile}' (see list_steel_profiles)` };
    const length = distance3(spec.end, spec.start);
    if (!(length > 0)) return { reason: 'start and end must differ' };
    const member: SteelMemberElement = {
      id: nextElementId(next, 'member'),
      category: 'member',
      mark: nextMemberMark(next, spec.role),
      entityIds: [],
      levelId,
      role: spec.role,
      profile: profile.name,
      start: spec.start,
      end: spec.end,
      roll: spec.roll ?? 0,
      material: spec.material?.trim() || 'S355',
      ...(spec.note ? { note: spec.note } : {}),
      ...(spec.startJoint !== undefined ? { startJoint: spec.startJoint } : {}),
      ...(spec.endJoint !== undefined ? { endJoint: spec.endJoint } : {}),
      ...(spec.baseFixity !== undefined ? { baseFixity: spec.baseFixity } : {}),
    };
    next = withElement(next, member);
    ids.push(member.id);
  }
  return { building: next, ids };
}
