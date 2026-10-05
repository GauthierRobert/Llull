/**
 * @layer domain-aec
 */

import type { SteelMemberElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import {
  elementAffected,
  fromMm,
  getBuilding,
  resolveLevel,
  toMetres,
  withElement,
} from '../model';
import { noop } from '@core/commands/noop';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { regenerateBuilding } from '../evaluateElements';
import { findProfile, type SteelProfile } from '../steel/profiles';
import { refitPlates } from './plateSupport';
import { dropStaleConnections } from './connectionSupport';
import {
  MEMBER_ROLES,
  appendMembers,
  baseFixitySchema,
  fixityProblem,
  jointFixitySchema,
  levelIdSchema,
  nextMemberMark,
  profileSummary,
  toVec3,
} from './memberSupport';

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
    if (!isFiniteNumber(roll)) {
      return noop(doc, 'add_steel_member failed: roll must be finite.');
    }
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
        ...(material !== undefined ? { material } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(startJoint !== undefined ? { startJoint } : {}),
        ...(endJoint !== undefined ? { endJoint } : {}),
        ...(baseFixity !== undefined ? { baseFixity } : {}),
      },
    ]);
    if ('reason' in added) return noop(doc, `add_steel_member failed: ${added.reason}.`);
    const document = regenerateBuilding(doc, added.building);
    const member = document.building?.elements[added.ids[0] as string];
    const section = findProfile(profile) as SteelProfile;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const metres = toMetres(doc, length);
    return {
      document,
      summary: `Added ${role} ${member?.mark ?? ''} (${added.ids[0] ?? ''}) ${profileSummary(section)}, length ${length.toFixed(1)} ${doc.units}, ${(metres * section.massPerMetre).toFixed(1)} kg${fixityText(startJoint, endJoint, baseFixity)}.`,
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
    'Edit a steel member: change its section (e.g. upsize IPE400 → IPE450), end points, role, roll, grade, note, ' +
    'beam joints (startJoint / endJoint pinned | rigid) or column baseFixity (pinned | fixed).',
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
    startJoint: jointFixitySchema
      .optional()
      .describe('Beams only: new joint at the start end, "pinned" or "rigid" (moment connection).'),
    endJoint: jointFixitySchema
      .optional()
      .describe('Beams only: new joint at the end end, "pinned" or "rigid".'),
    baseFixity: baseFixitySchema
      .optional()
      .describe('Columns only: new base fixity, "pinned" or "fixed".'),
  }),
  run: (
    doc,
    { memberId, profile, start, end, role, roll, material, note, startJoint, endJoint, baseFixity },
  ): CommandResult => {
    const building = getBuilding(doc);
    const member = building.elements[memberId];
    if (member?.category !== 'member')
      return noop(doc, `update_steel_member failed: no member '${memberId}'.`);
    const section = profile !== undefined ? findProfile(profile) : findProfile(member.profile);
    if (!section)
      return noop(doc, `update_steel_member failed: unknown steel profile '${profile ?? ''}'.`);
    const from = start !== undefined ? toVec3(start) : member.start;
    const to = end !== undefined ? toVec3(end) : member.end;
    if (!from || !to || (roll !== undefined && !isFiniteNumber(roll))) {
      return noop(doc, 'update_steel_member failed: start/end must be [x, y, z] and roll finite.');
    }
    if (Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) === 0) {
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
      role: role ?? member.role,
      mark:
        role !== undefined && role !== member.role ? nextMemberMark(building, role) : member.mark,
      roll: roll ?? member.roll,
      material: material?.trim() || member.material,
      ...(note !== undefined ? { note } : {}),
    };
    const refit = refitPlates(doc, withElement(building, updated), updated, member.profile);
    const stale = dropStaleConnections(refit.building, memberId, fromMm(doc, 10));
    const document = regenerateBuilding(doc, stale.building);
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
        `${stale.removed.length > 0 ? ` Moment connection(s) ${stale.removed.join(', ')} removed (joint no longer exists).` : ''}`,
      affected: elementAffected(document, [memberId, ...refit.resized]),
    };
  },
});
