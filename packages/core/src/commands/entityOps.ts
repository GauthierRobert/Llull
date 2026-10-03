import type { CadDocument, Entity, EntityGroup } from '../model/types';

/**
 * `doc` with `entity` stored and appended to `order`.
 * @pure
 */
export function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

/**
 * `doc` without entity `id` (also dropped from `order` and `selection`).
 * @pure
 */
export function withoutEntity(doc: CadDocument, id: string): CadDocument {
  const entities = { ...doc.entities };
  delete entities[id];
  return {
    ...doc,
    entities,
    order: doc.order.filter((eid) => eid !== id),
    selection: doc.selection.filter((eid) => eid !== id),
  };
}

/**
 * Remove `removedIds` from every group's `memberIds`; a group left with fewer than 2 members is
 * dissolved (omitted from `nextGroups`, listed in `dissolvedGroups`).
 *
 * @pure
 */
export function pruneGroupMembers(
  groups: Readonly<Record<string, EntityGroup>> | undefined,
  removedIds: ReadonlySet<string>,
): { nextGroups: Record<string, EntityGroup>; dissolvedGroups: string[] } {
  const dissolvedGroups: string[] = [];
  const nextGroups: Record<string, EntityGroup> = {};
  for (const group of Object.values(groups ?? {})) {
    const prunedIds = group.memberIds.filter((memberId) => !removedIds.has(memberId));
    if (prunedIds.length < 2) dissolvedGroups.push(group.id);
    else nextGroups[group.id] = { ...group, memberIds: prunedIds };
  }
  return { nextGroups, dissolvedGroups };
}

/**
 * `doc` with every `removedIds` entity consumed (entities/order/selection/groups) and `result`
 * stored and appended to `order`.
 * @pure
 */
export function replaceEntities(
  doc: CadDocument,
  removedIds: readonly string[],
  result: Entity,
): CadDocument {
  const removed = new Set(removedIds);
  const entities = { ...doc.entities };
  for (const id of removed) delete entities[id];
  return {
    ...doc,
    entities: { ...entities, [result.id]: result },
    order: [...doc.order.filter((id) => !removed.has(id)), result.id],
    selection: doc.selection.filter((id) => !removed.has(id)),
    groups: pruneGroupMembers(doc.groups, removed).nextGroups,
  };
}
