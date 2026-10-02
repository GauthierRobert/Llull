/**
 * Steel members, pad footings and cladding panels.
 * @layer core/commands/building/industrial
 */

import type { CadDocument, Vec2, Vec3 } from '../../../model/types';
import type {
  BuildingModel,
  FootingElement,
  MemberRole,
  PanelElement,
  SteelMemberElement,
} from '../../../model/building';
import type { CommandResult } from '../../types';
import { defineCommand, tolerant, z } from '../../schema';
import {
  elementAffected,
  fromMm,
  getBuilding,
  highestIndex,
  isFiniteNumber,
  isVec2,
  nextElementId,
  nextMark,
  noChange,
  resolveLevel,
  toMetres,
  toVec2,
  withElement,
} from '../model';
import { regenerateBuilding } from '../evaluate';
import { findProfile, STEEL_PROFILES, type SteelProfile } from '../steel/profiles';
import { panelFrame } from './evaluate';
import { refitPlates } from './plates';
import { dropStaleConnections } from './connections';

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
    // tolerant: lower-case / padded family names are normalised in run, as before MG2.
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
      return noChange(doc, 'list_steel_profiles: family must be a string such as "HEA".');
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

const levelIdSchema = z
  .string()
  .optional()
  .describe('Level id. Default: the active level (a "Level 0" is created if none).');

/**
 * @command add_steel_member
 * @pure
 * @affects creates 1 steel member (exact section mesh on its role layer)
 * @failure unknown profile / role, zero length, unknown level -> no-op
 */
export const addSteelMember = defineCommand({
  name: 'add_steel_member',
  description:
    'Add a steel member with a catalogue section (e.g. "HEA300", "IPE400", "CHS76.1x3.6") between two 3D ' +
    'points [x, y, z] (z above the level). Role sets the layer, mark and IFC class: column, rafter, beam, ' +
    'brace, purlin, rail (side rail / girt) or crane (runway beam). Section depth points up for beams and ' +
    'along +X for vertical columns; roll (radians) turns it about the axis.',
  params: z.object({
    profile: z.string().describe('Catalogue section name (list_steel_profiles).'),
    start: z.array(z.number()).describe('Axis start [x, y, z], z relative to the level.'),
    end: z.array(z.number()).describe('Axis end [x, y, z].'),
    role: z
      .enum([...MEMBER_ROLES])
      .optional()
      .describe('Structural role. Default beam.'),
    roll: z.number().optional().describe('Section rotation about the axis, radians. Default 0.'),
    levelId: levelIdSchema,
    material: z.string().optional().describe('Steel grade. Default S355.'),
    note: z.string().optional().describe('Note carried to the member schedule.'),
  }),
  run: (
    doc,
    { profile, start, end, role = 'beam', roll = 0, levelId, material, note },
  ): CommandResult => {
    const from = toVec3(start);
    const to = toVec3(end);
    if (!from || !to)
      return noChange(doc, 'add_steel_member failed: start and end must be [x, y, z].');
    if (!isFiniteNumber(roll)) {
      return noChange(doc, 'add_steel_member failed: roll must be finite.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noChange(doc, `add_steel_member failed: ${resolution.reason}.`);
    const added = appendMembers(resolution.building, resolution.level.id, [
      {
        role,
        profile,
        start: from,
        end: to,
        roll,
        ...(material !== undefined ? { material } : {}),
        ...(note !== undefined ? { note } : {}),
      },
    ]);
    if ('reason' in added) return noChange(doc, `add_steel_member failed: ${added.reason}.`);
    const document = regenerateBuilding(doc, added.building);
    const member = document.building?.elements[added.ids[0] as string];
    const section = findProfile(profile) as SteelProfile;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const metres = toMetres(doc, length);
    return {
      document,
      summary: `Added ${role} ${member?.mark ?? ''} (${added.ids[0] ?? ''}) ${profileSummary(section)}, length ${length.toFixed(1)} ${doc.units}, ${(metres * section.massPerMetre).toFixed(1)} kg.`,
      affected: elementAffected(document, added.ids),
      data: { elementId: added.ids[0] },
    };
  },
});

/**
 * @command update_steel_member
 * @pure
 * @failure unknown member / profile / role, zero length -> no-op
 */
export const updateSteelMember = defineCommand({
  name: 'update_steel_member',
  description:
    'Edit a steel member: change its section (e.g. upsize IPE400 → IPE450), end points, role, roll, grade or note.',
  params: z.object({
    memberId: z.string().describe('Member element id, e.g. "member-3".'),
    profile: z.string().optional().describe('New catalogue section.'),
    start: z.array(z.number()).optional().describe('New axis start [x, y, z].'),
    end: z.array(z.number()).optional().describe('New axis end [x, y, z].'),
    role: z
      .enum([...MEMBER_ROLES])
      .optional()
      .describe('New role.'),
    roll: z.number().optional().describe('New roll, radians.'),
    material: z.string().optional().describe('New steel grade.'),
    note: z.string().optional().describe('New schedule note.'),
  }),
  run: (doc, { memberId, profile, start, end, role, roll, material, note }): CommandResult => {
    const building = getBuilding(doc);
    const member = building.elements[memberId];
    if (member?.category !== 'member')
      return noChange(doc, `update_steel_member failed: no member '${memberId}'.`);
    const section = profile !== undefined ? findProfile(profile) : findProfile(member.profile);
    if (!section)
      return noChange(doc, `update_steel_member failed: unknown steel profile '${profile ?? ''}'.`);
    const from = start !== undefined ? toVec3(start) : member.start;
    const to = end !== undefined ? toVec3(end) : member.end;
    if (!from || !to || (roll !== undefined && !isFiniteNumber(roll))) {
      return noChange(
        doc,
        'update_steel_member failed: start/end must be [x, y, z] and roll finite.',
      );
    }
    if (Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) === 0) {
      return noChange(doc, 'update_steel_member failed: start and end would coincide.');
    }
    const updated: SteelMemberElement = {
      ...member,
      profile: section.name,
      start: from,
      end: to,
      role: role ?? member.role,
      mark:
        role !== undefined && role !== member.role ? nextMemberMark(building, role) : member.mark,
      roll: roll ?? member.roll,
      material: material?.trim() || member.material,
      ...(note !== undefined ? { note } : {}),
    };
    const refit = refitPlates(doc, withElement(building, updated), updated, member.profile);
    const joints = dropStaleConnections(refit.building, memberId, fromMm(doc, 10));
    const document = regenerateBuilding(doc, joints.building);
    const plateNote =
      refit.resized.length > 0
        ? ` Base plate(s) ${refit.resized.join(', ')} re-sized.`
        : refit.removed.length > 0
          ? ` Base plate(s) ${refit.removed.join(', ')} removed (no longer a column).`
          : '';
    return {
      document,
      summary:
        `Updated ${updated.role} ${updated.mark} (${memberId}): ${profileSummary(section)}.${plateNote}` +
        `${joints.removed.length > 0 ? ` Moment connection(s) ${joints.removed.join(', ')} removed (joint no longer exists).` : ''}`,
      affected: elementAffected(document, [memberId, ...refit.resized]),
    };
  },
});

/** Upper bound on members one generator call may create (keeps agents from hanging the host). */
export const MAX_GENERATED_MEMBERS = 5000;

/**
 * Plan positions of every column foot on a level (steel columns and concrete columns),
 * de-duplicated; restricted to `onlyIds` when given.
 */
export function columnFeet(
  building: BuildingModel,
  levelId: string,
  tolerance: number,
  onlyIds?: ReadonlySet<string>,
): Vec2[] {
  const feet: Vec2[] = [];
  for (const element of Object.values(building.elements)) {
    if (!('levelId' in element) || element.levelId !== levelId) continue;
    if (onlyIds && !onlyIds.has(element.id)) continue;
    let foot: Vec2 | null = null;
    if (element.category === 'column') foot = element.location;
    if (element.category === 'member' && element.role === 'column') {
      foot =
        element.start[2] <= element.end[2]
          ? [element.start[0], element.start[1]]
          : [element.end[0], element.end[1]];
    }
    if (
      foot &&
      !feet.some(
        (existing) => Math.hypot(existing[0] - foot[0], existing[1] - foot[1]) <= tolerance,
      )
    ) {
      feet.push(foot);
    }
  }
  return feet;
}

/** `locations` without the ones already carrying a footing on the level. */
export function withoutFootings(
  building: BuildingModel,
  levelId: string,
  locations: ReadonlyArray<Vec2>,
  tolerance: number,
): Vec2[] {
  const existing = Object.values(building.elements).flatMap((element) =>
    element.category === 'footing' && element.levelId === levelId ? [element.location] : [],
  );
  return locations.filter(
    (location) =>
      !existing.some(
        (footing) => Math.hypot(footing[0] - location[0], footing[1] - location[1]) <= tolerance,
      ),
  );
}

/** Adds pad footings (no regeneration). */
export function appendFootings(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  locations: ReadonlyArray<Vec2>,
  size: {
    width?: number;
    length?: number;
    thickness?: number;
    topOffset?: number;
    material?: string;
  },
): { building: BuildingModel; ids: string[] } {
  let next = building;
  const ids: string[] = [];
  const width = size.width ?? fromMm(doc, 1500);
  for (const location of locations) {
    const footing: FootingElement = {
      id: nextElementId(next, 'footing'),
      category: 'footing',
      mark: nextMark(next, 'footing'),
      entityIds: [],
      levelId,
      location: toVec2(location),
      width,
      length: size.length ?? width,
      thickness: size.thickness ?? fromMm(doc, 600),
      topOffset: size.topOffset ?? -fromMm(doc, 300),
      material: size.material?.trim() || 'concrete',
    };
    next = withElement(next, footing);
    ids.push(footing.id);
  }
  return { building: next, ids };
}

/**
 * @command add_footing
 * @pure
 * @affects creates 1 pad footing, or one under every column of the level
 * @failure no location / no columns / sizes <= 0 -> no-op
 */
export const addFooting = defineCommand({
  name: 'add_footing',
  description:
    'Add concrete pad footings: one at a plan location, or (underColumns: true) one under every steel and ' +
    'concrete column foot of the level. Top of footing at level + topOffset (default −300 mm); default ' +
    '1500 × 1500 × 600 mm.',
  params: z.object({
    location: z.array(z.number()).optional().describe('Footing centre [x, y].'),
    underColumns: z.boolean().optional().describe('Place one under each column of the level.'),
    width: z.number().optional().describe('Size along X. Default 1500 mm.'),
    length: z.number().optional().describe('Size along Y. Default = width.'),
    thickness: z.number().optional().describe('Depth of the pad. Default 600 mm.'),
    topOffset: z
      .number()
      .optional()
      .describe('Top of footing relative to the level. Default −300 mm.'),
    levelId: levelIdSchema,
    material: z.string().optional().describe('Default concrete.'),
  }),
  run: (doc, params): CommandResult => {
    const positive = (value: number | undefined): boolean =>
      value === undefined || (isFiniteNumber(value) && value > 0);
    if (!positive(params.width) || !positive(params.length) || !positive(params.thickness)) {
      return noChange(doc, 'add_footing failed: width, length and thickness must be > 0.');
    }
    if (params.topOffset !== undefined && !isFiniteNumber(params.topOffset)) {
      return noChange(doc, 'add_footing failed: topOffset must be finite.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok) return noChange(doc, `add_footing failed: ${resolution.reason}.`);
    const feet = params.underColumns
      ? columnFeet(resolution.building, resolution.level.id, fromMm(doc, 10))
      : [];
    const locations = params.underColumns
      ? withoutFootings(resolution.building, resolution.level.id, feet, fromMm(doc, 10))
      : isVec2(params.location)
        ? [toVec2(params.location)]
        : [];
    if (locations.length === 0) {
      return noChange(
        doc,
        !params.underColumns
          ? 'add_footing failed: location must be [x, y] (or set underColumns).'
          : feet.length === 0
            ? 'add_footing failed: the level has no columns.'
            : 'add_footing failed: every column already has a footing.',
      );
    }
    const added = appendFootings(doc, resolution.building, resolution.level.id, locations, {
      ...(params.width !== undefined ? { width: params.width } : {}),
      ...(params.length !== undefined ? { length: params.length } : {}),
      ...(params.thickness !== undefined ? { thickness: params.thickness } : {}),
      ...(params.topOffset !== undefined ? { topOffset: params.topOffset } : {}),
      ...(params.material !== undefined ? { material: params.material } : {}),
    });
    const document = regenerateBuilding(doc, added.building);
    return {
      document,
      summary: `Added ${added.ids.length} pad footing(s) ${added.ids.join(', ')}.`,
      affected: elementAffected(document, added.ids),
      data: { elementIds: added.ids },
    };
  },
});

/** Adds one cladding panel (no regeneration); null when the corners are not a usable plane. */
export function appendPanel(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  spec: { corners: Vec3[]; role: 'roof' | 'wall'; thickness?: number; material?: string },
): { building: BuildingModel; id: string } | null {
  if (spec.corners.length < 3 || !panelFrame(spec.corners)) return null;
  const panel: PanelElement = {
    id: nextElementId(building, 'panel'),
    category: 'panel',
    mark: nextMark(building, 'panel'),
    entityIds: [],
    levelId,
    role: spec.role,
    corners: spec.corners,
    thickness: spec.thickness ?? fromMm(doc, 80),
    material: spec.material?.trim() || 'sandwich-panel',
  };
  return { building: withElement(building, panel), id: panel.id };
}

/**
 * @command add_panel
 * @pure
 * @affects creates 1 cladding panel (mesh on layer A-CLAD)
 * @failure < 3 corners / degenerate plane / thickness <= 0 -> no-op
 */
export const addPanel = defineCommand({
  name: 'add_panel',
  description:
    'Add a planar cladding, roofing or sandwich panel through 3D corners [[x, y, z], …] (z above the level). ' +
    'The panel thickness grows along the plane normal (right-hand rule on the corner order). Use for ' +
    'pitched roofs, façades and gables.',
  params: z.object({
    corners: z.array(z.array(z.number())).describe('Coplanar corners [[x, y, z], …], at least 3.'),
    role: z.enum(['roof', 'wall']).optional().describe('Roofing or wall cladding. Default wall.'),
    thickness: z.number().optional().describe('Panel thickness. Default 80 mm.'),
    levelId: levelIdSchema,
    material: z.string().optional().describe('Default sandwich-panel (or steel-sheet, …).'),
  }),
  run: (doc, { corners, role = 'wall', thickness, levelId, material }): CommandResult => {
    const points = Array.isArray(corners) ? corners.map(toVec3) : [];
    if (points.length < 3 || points.some((point) => point === null)) {
      return noChange(doc, 'add_panel failed: corners must be ≥ 3 [x, y, z] points.');
    }
    if (thickness !== undefined && !(isFiniteNumber(thickness) && thickness > 0)) {
      return noChange(doc, 'add_panel failed: thickness must be > 0.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noChange(doc, `add_panel failed: ${resolution.reason}.`);
    const added = appendPanel(doc, resolution.building, resolution.level.id, {
      corners: points as Vec3[],
      role: role === 'roof' ? 'roof' : 'wall',
      ...(thickness !== undefined ? { thickness } : {}),
      ...(material !== undefined ? { material } : {}),
    });
    if (!added) return noChange(doc, 'add_panel failed: the corners do not span a plane.');
    const document = regenerateBuilding(doc, added.building);
    return {
      document,
      summary: `Added ${role} panel ${document.building?.elements[added.id]?.mark ?? ''} (${added.id}).`,
      affected: elementAffected(document, [added.id]),
      data: { elementId: added.id },
    };
  },
});
