/**
 * @layer domain-aec
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { SteelMemberElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, looseVec3, z } from '@core/commands/schema';
import {
  elementAffected,
  fromMm,
  getBuilding,
  resolveLevel,
  toMetres,
  withElement,
} from '../model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from '../evaluateElements';
import { distance3 } from '@lib/vec3';
import { findProfile, type SteelProfile } from '../steel/profiles';
import { refitPlates } from './plateSupport';
import { dropStaleConnections } from './connectionSupport';
import { reconcilePipeSupports, reconciliationNote } from './pipeSupportAttach';
import {
  MEMBER_ROLES,
  appendMembers,
  baseFixitySchema,
  fixityProblem,
  jointFixitySchema,
  nextMemberMark,
  profileSummary,
  toVec3,
} from './memberSupport';
import { levelIdParam } from '../levelParams';

const fixityText = (
  startJoint: string | undefined,
  endJoint: string | undefined,
  baseFixity: string | undefined,
): string =>
  [
    startJoint === 'rigid' ? 'rigid start joint' : '',
    endJoint === 'rigid' ? 'rigid end joint' : '',
    baseFixity === 'fixed' ? 'fixed base' : '',
  ]
    .filter((part) => part !== '')
    .map((part) => `, ${part}`)
    .join('');

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
    'along +X for vertical columns (roll π/2 turns it along +Y); roll (radians) turns it about the axis. ' +
    'Beams may declare startJoint / endJoint "rigid" (moment connection to the column they frame into; ' +
    'default pinned) and columns baseFixity "fixed" (column foot restrains rotation; default pinned or the ' +
    'base plate fixity): check_steel_members analyses rigidly connected beams and columns as planar moment frames.',
  params: z.object({
    profile: z.string().describe('Catalogue section name (list_steel_profiles).'),
    start: looseVec3('Axis start [x, y, z], z relative to the level; [x, y] means z = 0.'),
    end: looseVec3('Axis end [x, y, z]; [x, y] means z = 0.'),
    role: z
      .enum([...MEMBER_ROLES])
      .optional()
      .describe('Structural role. Default beam.'),
    roll: z.number().optional().describe('Section rotation about the axis, radians. Default 0.'),
    levelId: levelIdParam,
    material: z.string().optional().describe('Steel grade. Default S355.'),
    note: z.string().optional().describe('Note carried to the member schedule.'),
    startJoint: jointFixitySchema
      .optional()
      .describe(
        'Beams only: joint at the start end: "pinned" (default) or "rigid" (moment connection to the column it frames into).',
      ),
    endJoint: jointFixitySchema
      .optional()
      .describe('Beams only: joint at the end end: "pinned" (default) or "rigid".'),
    baseFixity: baseFixitySchema
      .optional()
      .describe(
        'Columns only: "pinned" (default; or the fixity of its base plate) or "fixed" (the foot restrains rotation in check_steel_members).',
      ),
  }),
  run: (
    doc,
    {
      profile,
      start,
      end,
      role = 'beam',
      roll = 0,
      levelId,
      material,
      note,
      startJoint,
      endJoint,
      baseFixity,
    },
  ): CommandResult => {
    const from = toVec3(start);
    const to = toVec3(end);
    if (!from || !to) return noop(doc, 'add_steel_member failed: start and end must be [x, y, z].');
    const problem = fixityProblem(role, { startJoint, endJoint, baseFixity });
    if (problem) return noop(doc, `add_steel_member failed: ${problem}.`);
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noop(doc, `add_steel_member failed: ${resolution.reason}.`);
    const added = appendMembers(resolution.building, resolution.level.id, [
      {
        role,
        profile,
        start: from,
        end: to,
        roll,
        material,
        note,
        startJoint,
        endJoint,
        baseFixity,
      },
    ]);
    if ('reason' in added) return noop(doc, `add_steel_member failed: ${added.reason}.`);
    const document = regenerateBuilding(doc, added.building);
    const member = document.building?.elements[added.ids[0] as string];
    const section = findProfile(profile) as SteelProfile;
    const length = distance3(to, from);
    const metres = toMetres(doc, length);
    return {
      document,
      summary: `Added ${role} ${member?.mark ?? ''} (${added.ids[0] ?? ''}) ${profileSummary(section)}, length ${length.toFixed(1)} ${doc.units}, ${(metres * section.massPerMetre).toFixed(1)} kg${fixityText(startJoint, endJoint, baseFixity)}.`,
      affected: elementAffected(document, added.ids),
      data: { elementId: added.ids[0] },
    };
  },
});

const shiftZ = (point: Vec3, dz: number): Vec3 => [point[0], point[1], point[2] + dz];

/** Axis z change that keeps the top of a horizontal member when its section depth changes; 0 unless roll is 0 or π (mod 2π). */
function topOfSteelShift(
  doc: Pick<CadDocument, 'units'>,
  member: SteelMemberElement,
  section: SteelProfile,
): number {
  const old = findProfile(member.profile);
  const horizontal = Math.abs(member.end[2] - member.start[2]) < 1e-9;
  const turns = Math.abs(member.roll) / Math.PI;
  const flat = Math.abs(turns - Math.round(turns)) < 1e-6;
  if (!old || !horizontal || !flat) return 0;
  return fromMm(doc, (old.h - section.h) / 2);
}

/**
 * @command update_steel_member
 * @pure
 * @failure unknown member / profile / role, zero length -> no-op
 */
export const updateSteelMember = defineCommand({
  name: 'update_steel_member',
  description:
    'Edit a steel member: change its section (e.g. upsize IPE400 → IPE450; a horizontal member with roll 0 or π keeps its top of steel, other rolls keep the axis height), end points, role, roll, grade, note, ' +
    'beam joints (startJoint / endJoint pinned | rigid) or column baseFixity (pinned | fixed). Pipe supports ' +
    'bearing on the member re-check their reach: kept (pedestal / rod updated), re-attached to other steel, or ' +
    'unattached (the summary says which).',
  params: z.object({
    memberId: z.string().describe('Member element id, e.g. "member-3".'),
    profile: z.string().optional().describe('New catalogue section.'),
    start: looseVec3('New axis start [x, y, z]; [x, y] means z = 0.').optional(),
    end: looseVec3('New axis end [x, y, z]; [x, y] means z = 0.').optional(),
    role: z
      .enum([...MEMBER_ROLES])
      .optional()
      .describe('New role.'),
    roll: z.number().optional().describe('New roll, radians.'),
    material: z.string().optional().describe('New steel grade.'),
    note: z.string().optional().describe('New schedule note.'),
    startJoint: jointFixitySchema
      .optional()
      .describe('Beams only: new joint at the start end, "pinned" or "rigid" (moment connection).'),
    endJoint: jointFixitySchema
      .optional()
      .describe('Beams only: new joint at the end end, "pinned" or "rigid".'),
    baseFixity: baseFixitySchema
      .optional()
      .describe('Columns only: new base fixity, "pinned" or "fixed".'),
    keepTopOfSteel: z
      .boolean()
      .optional()
      .describe(
        'Horizontal members with a new profile and no new start / end: shift the axis down by half the ' +
          'depth increase (up for a decrease) so the top of steel stays where it was, e.g. under a grating. ' +
          'Default false (the axis stays).',
      ),
  }),
  run: (
    doc,
    {
      memberId,
      profile,
      start,
      end,
      role,
      roll,
      material,
      note,
      startJoint,
      endJoint,
      baseFixity,
      keepTopOfSteel = false,
    },
  ): CommandResult => {
    const building = getBuilding(doc);
    const member = building.elements[memberId];
    if (member?.category !== 'member')
      return noop(doc, `update_steel_member failed: no member '${memberId}'.`);
    const section = findProfile(profile ?? member.profile);
    if (!section)
      return noop(doc, `update_steel_member failed: unknown steel profile '${profile ?? ''}'.`);
    const topShift =
      keepTopOfSteel && start === undefined && end === undefined
        ? topOfSteelShift(doc, member, section)
        : 0;
    const from = start !== undefined ? toVec3(start) : shiftZ(member.start, topShift);
    const to = end !== undefined ? toVec3(end) : shiftZ(member.end, topShift);
    if (!from || !to) {
      return noop(
        doc,
        'update_steel_member failed: start/end must be [x, y, z] (or [x, y] with z = 0).',
      );
    }
    if (distance3(to, from) === 0) {
      return noop(doc, 'update_steel_member failed: start and end would coincide.');
    }
    const nextRole = role ?? member.role;
    const problem = fixityProblem(nextRole, { startJoint, endJoint, baseFixity });
    if (problem) return noop(doc, `update_steel_member failed: ${problem}.`);
    const { startJoint: oldStart, endJoint: oldEnd, baseFixity: oldBase, ...rest } = member;
    const isBeam = nextRole === 'beam';
    const fixities = {
      ...(isBeam && (startJoint ?? oldStart) ? { startJoint: startJoint ?? oldStart } : {}),
      ...(isBeam && (endJoint ?? oldEnd) ? { endJoint: endJoint ?? oldEnd } : {}),
      ...(nextRole === 'column' && (baseFixity ?? oldBase)
        ? { baseFixity: baseFixity ?? oldBase }
        : {}),
    };
    const updated: SteelMemberElement = {
      ...rest,
      ...fixities,
      profile: section.name,
      start: from,
      end: to,
      role: nextRole,
      mark: nextRole !== member.role ? nextMemberMark(building, nextRole) : member.mark,
      roll: roll ?? member.roll,
      material: material?.trim() || member.material,
      ...(note !== undefined ? { note } : {}),
    };
    const sameFields = (Object.keys(updated) as Array<keyof SteelMemberElement>).every(
      (key) => JSON.stringify(updated[key]) === JSON.stringify(member[key]),
    );
    if (sameFields && Object.keys(member).length === Object.keys(updated).length) {
      return noop(
        doc,
        `update_steel_member: ${memberId} already has these values; nothing changed.`,
      );
    }
    const refit = refitPlates(doc, withElement(building, updated), updated, member.profile);
    const stale = dropStaleConnections(refit.building, memberId, fromMm(doc, 10));
    const supports = reconcilePipeSupports(doc, stale.building);
    const document = regenerateBuilding(doc, supports.building);
    const removedIds = [...refit.removed, ...stale.removed];
    const plateNote =
      refit.resized.length > 0
        ? ` Base plate(s) ${refit.resized.join(', ')} re-sized.`
        : refit.removed.length > 0
          ? ` Base plate(s) ${refit.removed.join(', ')} removed (no longer a column).`
          : '';
    return {
      document,
      summary:
        `Updated ${updated.role} ${updated.mark} (${memberId}): ${profileSummary(section)}` +
        `${topShift !== 0 ? `, axis moved ${topShift > 0 ? 'up' : 'down'} ${Math.abs(topShift).toFixed(1)} ${doc.units} to keep the top of steel` : ''}.${plateNote}` +
        `${stale.removed.length > 0 ? ` Moment connection(s) ${stale.removed.join(', ')} removed (joint no longer exists).` : ''}${reconciliationNote(supports)}`,
      affected: [
        ...elementAffected(document, [
          memberId,
          ...refit.resized,
          ...[...supports.reattached, ...supports.detached].map((change) => change.id),
        ]),
        ...removedIds,
        ...removedIds.flatMap((id) => building.elements[id]?.entityIds ?? []),
      ],
    };
  },
});
