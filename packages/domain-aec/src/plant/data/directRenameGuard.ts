/**
 * Direct renames of classified equipment (plant 08 DAT §13.8): the mark of equipment a plant object stands for changes only together with that object's
 * tag, so the tag registry, the line ends of plant objects and the data sheets never disagree with the model.
 */

import type { DerivationGuard, GuardRefusal } from '@core/commands/derivation';
import { commandError } from '@core/commands/noop';
import { getBuilding } from '../../building/model';
import { getPlantData, own, targetKey } from './model';
import { objectRegistry } from './registry';
import { normaliseTag } from './tagFormat';

const refusal = (equipment: string, object: string, from: string, to: string): GuardRefusal => ({
  reason:
    `DAT_DIRECT_RENAME — equipment ${equipment} is classified as plant object ${object} (tag ${from}) and may not be renamed to ${to} behind its back; ` +
    'change its tag through plant data (set_plant_properties on a tag field, set_tag_format with retag), or unassign_plant_object first',
  error: commandError(
    'DAT_DIRECT_RENAME',
    'change the tag through plant data (set_plant_properties on a tag-driving property, set_tag_format with retag, assign_plant_object re-bind), or unassign_plant_object first to rename the equipment freely',
    [equipment, object],
    ['renames'],
  ),
});

/**
 * @invariant an equipment whose plant object carried its mark as tag keeps agreeing with it: a command result that changes the mark without the object's tag is refused (DAT_DIRECT_RENAME)
 */
export const directRenameGuard: DerivationGuard = {
  domain: 'plant-data',
  check(previous, next): GuardRefusal | null {
    const before = getBuilding(previous);
    const after = getBuilding(next);
    if (before === after) return null;
    const data = getPlantData(previous);
    if (data.objectOrder.length === 0) return null;
    const claimed = objectRegistry(data).byTarget;
    const nextObjects = getPlantData(next).objects;
    for (const id of before.elementOrder) {
      const was = before.elements[id];
      const now = after.elements[id];
      if (was?.category !== 'equipment' || now?.category !== 'equipment' || was.mark === now.mark) continue;
      const ownerId = claimed.get(targetKey({ kind: 'buildingElement', id }) as string);
      const owner = ownerId === undefined ? undefined : own(data.objects, ownerId);
      if (owner === undefined || normaliseTag(owner.tag) !== normaliseTag(was.mark)) continue;
      const kept = ownerId === undefined ? undefined : own(nextObjects, ownerId);
      if (kept !== undefined && normaliseTag(kept.tag) !== normaliseTag(now.mark)) return refusal(id, owner.id, was.mark, now.mark);
    }
    return null;
  },
};
