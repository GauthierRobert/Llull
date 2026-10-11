/**
 * @layer domain-aec
 */

import type { EquipmentElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, looseVec2, vec3, z } from '@core/commands/schema';
import {
  elementAffected,
  elementsOf,
  getBuilding,
  isVec2,
  resolveLevel,
  toVec2,
  withElement,
} from '../model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from '../evaluateElements';
import {
  SHAPE_PARAM_TEXT,
  describeEquipmentShape,
  equipmentShapeSchema,
  normaliseEquipmentSize,
  shapeOf,
} from './equipmentShape';

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
    'maintenance clearance, operating weight, shape (box / vertical_vessel / horizontal_vessel) or level. Identify it by `elementId` (e.g. "equipment-2") or by ' +
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
    size: vec3(
      'New size, three numbers. box: [length, width, height], all > 0. vertical_vessel: [diameter, ignored, height]. horizontal_vessel: [length along local x, diameter, ignored]. Vessel sizes are normalised to their bounding box.',
    ).optional(),
    shape: equipmentShapeSchema.optional().describe(`New shape. ${SHAPE_PARAM_TEXT}`),
    angle: z.number().optional().describe('New plan rotation in radians.'),
    clearance: z
      .number()
      .optional()
      .describe('New maintenance clearance in document units (>= 0).'),
    weight: z.number().optional().describe('New operating weight in kg (>= 0).'),
    levelId: z.string().optional().describe('Move the equipment to this level id.'),
  }),
  run: (
    doc,
    {
      elementId,
      currentMark,
      name,
      mark,
      location,
      size,
      shape,
      angle,
      clearance,
      weight,
      levelId,
    },
  ): CommandResult => {
    const building = getBuilding(doc);
    const equipments = elementsOf(building, 'equipment');
    let target: EquipmentElement | undefined;
    if (elementId !== undefined) {
      const element = building.elements[elementId];
      if (element === undefined)
        return noop(doc, `update_equipment failed: no element '${elementId}'.`);
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
    const newShape = shape ?? shapeOf(equipment);
    const dimensions = normaliseEquipmentSize(newShape, size ?? equipment.size);
    if (!dimensions) {
      return noop(
        doc,
        `update_equipment failed: size must be 3 numbers valid for shape ${newShape} (box: all > 0; vertical_vessel: diameter and height > 0; horizontal_vessel: length and diameter > 0).`,
      );
    }
    if (location !== undefined && !isVec2(location))
      return noop(doc, 'update_equipment failed: location must be [x, y] with finite numbers.');
    const next = {
      angle: angle ?? equipment.angle,
      clearance: clearance ?? equipment.clearance,
      weight: weight ?? equipment.weight,
    };
    if (next.clearance < 0 || next.weight < 0)
      return noop(doc, 'update_equipment failed: clearance >= 0 and weight >= 0.');
    const newName = name !== undefined ? name.trim() : equipment.name;
    const newMark = mark !== undefined ? mark.trim() : equipment.mark;
    if (newName === '' || newMark === '')
      return noop(doc, 'update_equipment failed: name and mark cannot be empty.');
    const clash = equipments.find((other) => other.id !== equipment.id && other.mark === newMark);
    if (clash)
      return noop(doc, `update_equipment failed: tag '${newMark}' is already used by ${clash.id}.`);
    const resolution = resolveLevel(doc, building, levelId ?? equipment.levelId);
    if (!resolution.ok) return noop(doc, `update_equipment failed: ${resolution.reason}.`);
    const withoutShape: EquipmentElement = { ...equipment };
    delete withoutShape.shape;
    const updated: EquipmentElement = {
      ...withoutShape,
      ...(newShape !== 'box' ? { shape: newShape } : {}),
      name: newName,
      mark: newMark,
      location: location !== undefined ? toVec2(location) : equipment.location,
      size: dimensions,
      ...next,
      levelId: resolution.level.id,
    };
    const sameNumbers = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
      a.length === b.length && a.every((value, index) => value === b[index]);
    if (
      updated.name === equipment.name &&
      updated.mark === equipment.mark &&
      updated.levelId === equipment.levelId &&
      updated.angle === equipment.angle &&
      updated.clearance === equipment.clearance &&
      updated.weight === equipment.weight &&
      newShape === shapeOf(equipment) &&
      sameNumbers(updated.location, equipment.location) &&
      sameNumbers(updated.size, equipment.size)
    ) {
      return noop(
        doc,
        `update_equipment: ${equipment.id} already has these values; nothing changed.`,
      );
    }
    const document = regenerateBuilding(doc, withElement(building, updated));
    return {
      document,
      summary:
        `Updated equipment ${updated.mark} "${updated.name}" (${updated.id}): ` +
        `[${updated.location.join(', ')}] on ${updated.levelId}, ${describeEquipmentShape(newShape, updated.size, doc.units)}, ` +
        `clearance ${updated.clearance}, ${updated.weight} kg.`,
      affected: elementAffected(document, [updated.id]),
      data: { elementId: updated.id },
    };
  },
});
