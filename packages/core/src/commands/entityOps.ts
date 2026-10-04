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
 * `doc` with `entity` stored under its id (order unchanged).
 * @pure
 */
export function replaceEntity(doc: CadDocument, entity: Entity): CadDocument {
  return { ...doc, entities: { ...doc.entities, [entity.id]: entity } };
}

/**
 * `doc` without entity `id` (also dropped from `order` and `selection`).
 * @pure
 */
export function withoutEntity(doc: CadDocument, id: string): CadDocument {
  return withoutEntities(doc, new Set([id]), false).document;
}

/**
 * Remove `removedIds` from every group's `memberIds`; a group left with fewer than 2 members is
 * dissolved (omitted from `nextGroups`, listed in `dissolvedGroups`).
 *
 * @pure
 */
function pruneGroupMembers(
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
 * `doc` without `removed` entities (entities/order/selection; with `pruneGroups`, also group
 * memberships — groups left with fewer than 2 members are dissolved and listed).
 * @pure
 */
export function withoutEntities(
  doc: CadDocument,
  removed: ReadonlySet<string>,
  pruneGroups = true,
): { document: CadDocument; dissolvedGroups: string[] } {
  const entities = { ...doc.entities };
  for (const id of removed) delete entities[id];
  const base: CadDocument = {
    ...doc,
    entities,
    order: doc.order.filter((id) => !removed.has(id)),
    selection: doc.selection.filter((id) => !removed.has(id)),
  };
  if (!pruneGroups) return { document: base, dissolvedGroups: [] };
  const { nextGroups, dissolvedGroups } = pruneGroupMembers(doc.groups, removed);
  return { document: { ...base, groups: nextGroups }, dissolvedGroups };
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
  return withEntity(withoutEntities(doc, new Set(removedIds)).document, result);
}
