/**
 * @layer domain-aec
 */

import type { EquipmentElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, looseVec2, vec3, z } from '@core/commands/schema';
import { elementAffected, getBuilding, isVec2, resolveLevel, toVec2, withElement } from '../model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from '../evaluateElements';

/**
 * @command update_equipment
 * @pure
 * @affects regenerates 1 equipment (same element id, mark kept unless renamed)
 * @invariant element id, GlobalId seed and schedule row identity survive the edit
 * @failure unknown element / tag, not equipment, ambiguous tag, duplicate mark, invalid values, unknown level -> no-op
 */
export const updateEquipment = defineCommand({
  name: 'update_equipment',
  description:
    'Edit an existing equipment in place (revision): name, tag (mark), plan centre, size, plan rotation, ' +
    'maintenance clearance, operating weight or level. Identify it by `elementId` (e.g. "equipment-2") or by ' +
    'its current tag `currentMark` (e.g. "EQ3"). The element id is kept, so schedules, plan tags and IFC ' +
    'GlobalIds stay stable across the revision. Fields you omit are unchanged.',
  params: z.object({
    elementId: z.string().optional().describe('Equipment element id, e.g. "equipment-2".'),
    currentMark: z
      .string()
      .optional()
      .describe('Current equipment tag, e.g. "EQ3"; used when `elementId` is omitted.'),
    name: z.string().optional().describe('New equipment name.'),
    mark: z.string().optional().describe('New equipment tag (must not clash with another tag).'),
    location: looseVec2('New footprint centre [x, y] (a trailing z is ignored).').optional(),
    size: vec3('New [length, width, height], all > 0.').optional(),
    angle: z.number().optional().describe('New plan rotation in radians.'),
    clearance: z.number().optional().describe('New maintenance clearance (>= 0).'),
    weight: z.number().optional().describe('New operating weight in kg (>= 0).'),
    levelId: z.string().optional().describe('Move the equipment to this level id.'),
  }),
  run: (
    doc,
    { elementId, currentMark, name, mark, location, size, angle, clearance, weight, levelId },
  ): CommandResult => {
    const building = getBuilding(doc);
    const equipments = Object.values(building.elements).filter(
      (element): element is EquipmentElement => element.category === 'equipment',
    );
    let target: EquipmentElement | undefined;
    if (elementId !== undefined) {
      const element = building.elements[elementId];
      if (element === undefined) {
        return noop(doc, `update_equipment failed: no element '${elementId}'.`);
      }
      if (element.category !== 'equipment') {
        return noop(
          doc,
          `update_equipment failed: '${elementId}' is a ${element.category}, not equipment.`,
        );
      }
      target = element;
    } else if (currentMark !== undefined) {
      const matches = equipments.filter((element) => element.mark === currentMark.trim());
      if (matches.length > 1) {
        return noop(
          doc,
          `update_equipment failed: tag '${currentMark}' is ambiguous (${matches.map((m) => m.id).join(', ')}); use elementId.`,
        );
      }
      target = matches[0];
      if (!target)
        return noop(doc, `update_equipment failed: no equipment tagged '${currentMark}'.`);
    } else {
      return noop(doc, 'update_equipment failed: give elementId or currentMark.');
    }
    const equipment = target;
    if (location !== undefined && !isVec2(location)) {
      return noop(doc, 'update_equipment failed: location must be [x, y] with finite numbers.');
    }
    const dimensions = size ?? equipment.size;
    if (dimensions.some((v) => !(v > 0))) {
      return noop(doc, 'update_equipment failed: size must be [length, width, height], all > 0.');
    }
    const next = {
      angle: angle ?? equipment.angle,
      clearance: clearance ?? equipment.clearance,
      weight: weight ?? equipment.weight,
    };
    if (next.clearance < 0 || next.weight < 0) {
      return noop(doc, 'update_equipment failed: clearance >= 0 and weight >= 0.');
    }
    const newName = name !== undefined ? name.trim() : equipment.name;
    const newMark = mark !== undefined ? mark.trim() : equipment.mark;
    if (newName === '' || newMark === '') {
      return noop(doc, 'update_equipment failed: name and mark cannot be empty.');
    }
    const clash = equipments.find((other) => other.id !== equipment.id && other.mark === newMark);
    if (clash) {
      return noop(doc, `update_equipment failed: tag '${newMark}' is already used by ${clash.id}.`);
    }
    const resolution = resolveLevel(doc, building, levelId ?? equipment.levelId);
    if (!resolution.ok) return noop(doc, `update_equipment failed: ${resolution.reason}.`);
    const updated: EquipmentElement = {
      ...equipment,
      name: newName,
      mark: newMark,
      location: location !== undefined ? toVec2(location) : equipment.location,
      size: dimensions,
      ...next,
      levelId: resolution.level.id,
    };
    const document = regenerateBuilding(doc, withElement(building, updated));
    return {
      document,
      summary:
        `Updated equipment ${updated.mark} "${updated.name}" (${updated.id}): ` +
        `[${updated.location.join(', ')}] on ${updated.levelId}, ${updated.size.join(' × ')} ${doc.units}, ` +
        `clearance ${updated.clearance}, ${updated.weight} kg.`,
      affected: elementAffected(document, [updated.id]),
      data: { elementId: updated.id },
    };
  },
});
