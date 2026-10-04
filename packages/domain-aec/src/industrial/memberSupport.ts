/**
 * @layer domain-aec
 */

import type { Vec3 } from '@core/model/types';
import type { BuildingModel, MemberRole, SteelMemberElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, tolerant, z } from '@core/commands/schema';
import { highestIndex, nextElementId, withElement } from '../model';
import { noop } from '@core/commands/noop';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { findProfile, STEEL_PROFILES, type SteelProfile } from '../steel/profiles';

export const MEMBER_ROLES: ReadonlyArray<MemberRole> = [
  'column',
  'rafter',
  'beam',
  'brace',
  'purlin',
  'rail',
  'crane',
];

const ROLE_MARK: Readonly<Record<MemberRole, string>> = {
  column: 'SC',
  rafter: 'RF',
  beam: 'SB',
  brace: 'BR',
  purlin: 'PU',
  rail: 'SR',
  crane: 'CB',
};

/** Next mark for a member role, e.g. "SC4", "PU12". */
export function nextMemberMark(building: BuildingModel, role: MemberRole): string {
  const prefix = ROLE_MARK[role];
  const marks = Object.values(building.elements)
    .filter((element) => element.category === 'member')
    .map((element) => element.mark);
  return `${prefix}${highestIndex(marks, prefix) + 1}`;
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

interface MemberSpec {
  role: MemberRole;
  profile: string;
  start: Vec3;
  end: Vec3;
  roll?: number;
  material?: string;
  note?: string;
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
    const length = Math.hypot(
      spec.end[0] - spec.start[0],
      spec.end[1] - spec.start[1],
      spec.end[2] - spec.start[2],
    );
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
    };
    next = withElement(next, member);
    ids.push(member.id);
  }
  return { building: next, ids };
}

/**
 * @command list_steel_profiles
 * @pure read-only
 * @affects none; data = { profiles: SteelProfile[] }
 */
export const listSteelProfiles = defineCommand({
  name: 'list_steel_profiles',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only steel section catalogue: IPE, HEA, HEB, UPN, cold-formed C purlins, SHS, RHS, CHS and ' +
    'equal angles L, with depth h, width b, web / flange thickness (mm), mass (kg/m), area (mm²) and paint ' +
    'perimeter (mm). Optionally filter by family.',
  params: z.object({
    // tolerant: lower-case / padded family names are normalised in run.
    family: tolerant(
      z
        .enum(['IPE', 'HEA', 'HEB', 'UPN', 'C', 'SHS', 'RHS', 'CHS', 'L'])
        .optional()
        .describe('Only this family.'),
    ),
  }),
  run: (doc, { family }): CommandResult => {
    const raw: unknown = family;
    if (raw !== undefined && typeof raw !== 'string') {
      return noop(doc, 'list_steel_profiles: family must be a string such as "HEA".');
    }
    const wanted = raw?.trim().toUpperCase();
    const profiles = STEEL_PROFILES.filter(
      (profile) => wanted === undefined || profile.family === wanted,
    );
    return {
      document: doc,
      summary: `${profiles.length} steel profile(s): ${profiles.map((profile) => profile.name).join(', ')}.`,
      affected: [],
      data: { profiles },
    };
  },
});

export const levelIdSchema = z
  .string()
  .optional()
  .describe('Level id. Default: the active level (a "Level 0" is created if none).');
