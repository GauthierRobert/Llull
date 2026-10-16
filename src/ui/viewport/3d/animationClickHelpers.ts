// Pure click-to-trigger animation helpers.

import type { Animation, EntityGroup, EntityId } from '@core/model/types';
import type { DynamicsModel } from '@core/model/dynamics';

/** `trigger:'click'` animations targeting `entityId` directly or through a group containing it. */
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

/** Every animation target (directly or via a group): moved by scene-object name, so never instanced. */
export function animatedEntityIds(animations: Record<string, Animation>, groups: Record<string, EntityGroup>): Set<EntityId> {
  const result = new Set<EntityId>();
  for (const anim of Object.values(animations)) {
    if (anim.targetKind === 'entity') result.add(anim.targetId);
    else for (const memberId of groups[anim.targetId]?.memberIds ?? []) result.add(memberId);
  }
  return result;
}

/** Entities of moving rigid bodies: replayed by DynamicsPlayer through their scene objects, so never instanced either. */
export function dynamicEntityIds(dynamics: DynamicsModel | undefined): Set<EntityId> {
  return new Set(Object.values(dynamics?.bodies ?? {}).flatMap((body) => (body.fixed ? [] : body.entityIds)));
}
