/**
 * @layer ui/viewport/3d
 *
 * Pure helpers for the click-to-trigger animation interaction.
 * Extracted from Entities.tsx so they can be unit-tested without a DOM (rule W3).
 */

import type { Animation, EntityGroup, EntityId } from '@core/model/types';

/**
 * Given a clicked `entityId` and the full animation + group maps from the document,
 * return the ids of all `trigger:'click'` animations that target this entity —
 * either directly (`targetKind:'entity'` with `targetId === entityId`) or
 * via a group (`targetKind:'group'` whose `memberIds` contains `entityId`).
 *
 * @pure — reads inputs only, returns a new array.
 */
export function findClickAnimationsForEntity(
  entityId: EntityId,
  animations: Record<string, Animation>,
  groups: Record<string, EntityGroup>,
): string[] {
  const result: string[] = [];
  for (const anim of Object.values(animations)) {
    if (anim.trigger !== 'click') continue;

    if (anim.targetKind === 'entity' && anim.targetId === entityId) {
      result.push(anim.id);
    } else if (anim.targetKind === 'group') {
      const group = groups[anim.targetId];
      if (group && group.memberIds.includes(entityId)) {
        result.push(anim.id);
      }
    }
  }
  return result;
}
