/**
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import type { SlabElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { polygonArea, rotatePoint2 } from '@lib/polygon';
import { elementAffected, fromMm, getBuilding, toMetres, withElement } from '../model';
import { regenerateBuilding } from '../evaluateElements';
import { slabOpeningError } from '../slabOpenings';
import { slabsCrossedBy } from './clashSlabs';

/**
 * @command add_equipment_openings
 * @pure
 * @affects cuts one opening in every floor / grating the equipment passes through
 * @failure unknown equipment, negative margin, no floor crossed, every cut refused -> no-op
 * @invariant opening = equipment plan rectangle (rotated) grown by `margin` on each side
 */
export const addEquipmentOpenings = defineCommand({
  name: 'add_equipment_openings',
  description:
    'Cut the floors around an equipment that passes through them (e.g. a 12 m desolventizer crossing two ' +
    'gratings): every slab whose top lies inside the equipment height and is solid under its footprint gets an ' +
    'opening = the equipment plan rectangle + margin. Clears the matching check_clashes hard clashes. ' +
    'A slab where the opening would not fit (outside the slab, touching another opening) is reported and left.',
  params: z.object({
    equipmentId: z.string().describe('Equipment element id, e.g. "equipment-2".'),
    margin: z
      .number()
      .optional()
      .describe(
        'Free gap around the footprint (toe plate / access), in document units; must be >= 0. Default: 300 mm converted to document units.',
      ),
  }),
  run: (doc, { equipmentId, margin }): CommandResult => {
    const building = getBuilding(doc);
    const equipment = building.elements[equipmentId];
    if (equipment?.category !== 'equipment')
      return noop(doc, `add_equipment_openings failed: no equipment '${equipmentId}'.`);
    const gap = margin ?? fromMm(doc, 300);
    if (!(gap >= 0)) return noop(doc, 'add_equipment_openings failed: margin must be >= 0.');
    const crossed = slabsCrossedBy(building, equipment, fromMm(doc, 5));
    if (crossed.length === 0) {
      return noop(
        doc,
        `add_equipment_openings: ${equipment.mark} crosses no floor without an opening — nothing to cut.`,
      );
    }
    const [halfLength, halfWidth] = [equipment.size[0] / 2 + gap, equipment.size[1] / 2 + gap];
    const outline: Vec2[] = (
      [
        [-halfLength, -halfWidth],
        [halfLength, -halfWidth],
        [halfLength, halfWidth],
        [-halfLength, halfWidth],
      ] as Vec2[]
    ).map((corner) => {
      const [x, y] = rotatePoint2(corner, equipment.angle);
      return [x + equipment.location[0], y + equipment.location[1]];
    });
    let next = building;
    const cut: SlabElement[] = [];
    const refused: string[] = [];
    for (const slab of crossed) {
      const error = slabOpeningError(slab, outline);
      if (error) {
        refused.push(`${slab.mark}: ${error}`);
        continue;
      }
      next = withElement(next, { ...slab, openings: [...(slab.openings ?? []), outline] });
      cut.push(slab);
    }
    if (cut.length === 0)
      return noop(doc, `add_equipment_openings refused: ${refused.join('; ')}.`);
    const document = regenerateBuilding(doc, next);
    const area = polygonArea(outline) * toMetres(doc, 1) ** 2;
    return {
      document,
      summary:
        `Cut ${area.toFixed(2)} m² opening(s) around ${equipment.mark} in ${cut.map((slab) => `${slab.mark} (${slab.id})`).join(', ')}` +
        `${refused.length > 0 ? `; not cut: ${refused.join('; ')}` : ''}.`,
      affected: elementAffected(
        document,
        cut.map((slab) => slab.id),
      ),
      data: { slabIds: cut.map((slab) => slab.id) },
    };
  },
});
