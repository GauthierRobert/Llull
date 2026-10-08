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
 * `doc` with every entity of `created` stored and appended to `order` (same result as folding
 * `withEntity`, but one pass instead of re-spreading the entity bag per entity).
 * @pure
 */
export function withEntities(doc: CadDocument, created: ReadonlyArray<Entity>): CadDocument {
  if (created.length === 0) return doc;
  const entities: CadDocument['entities'] = { ...doc.entities };
  for (const entity of created) entities[entity.id] = entity;
  return { ...doc, entities, order: [...doc.order, ...created.map((entity) => entity.id)] };
}

/**
 * `doc` with every entity of `changed` stored under its id (order unchanged); one pass, equal to
 * folding `replaceEntity`.
 * @pure
 */
export function replaceEntitiesById(doc: CadDocument, changed: ReadonlyArray<Entity>): CadDocument {
  if (changed.length === 0) return doc;
  const entities: CadDocument['entities'] = { ...doc.entities };
  for (const entity of changed) entities[entity.id] = entity;
  return { ...doc, entities };
}

/**
 * `doc` with `entity` stored under its id (order unchanged).
 * @pure
 */
export function replaceEntity(doc: CadDocument, entity: Entity): CadDocument {
  return { ...doc, entities: { ...doc.entities, [entity.id]: entity } };
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

/** Records of `record` whose key is not in `dropped`. */
function withoutKeys<T>(
  record: Readonly<Record<string, T>>,
  dropped: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !dropped.has(key)));
}

/** Constraint, joint and drive-relation records that do not reference a removed entity. */
function pruneReferences(
  doc: CadDocument,
  removed: ReadonlySet<string>,
): { references: Partial<CadDocument>; prunedReferences: number } {
  const droppedConstraints = new Set(
    Object.values(doc.constraints)
      .filter((c) => removed.has(c.a.entityId) || removed.has(c.b.entityId))
      .map((c) => c.id),
  );
  const droppedJoints = new Set(
    Object.values(doc.joints)
      .filter((j) => removed.has(j.a.instanceId) || removed.has(j.b.instanceId))
      .map((j) => j.id),
  );
  const droppedRelations = new Set(
    Object.values(doc.driveRelations)
      .filter((r) => droppedJoints.has(r.driver) || droppedJoints.has(r.driven))
      .map((r) => r.id),
  );
  const prunedReferences = droppedConstraints.size + droppedJoints.size + droppedRelations.size;
  if (prunedReferences === 0) return { references: {}, prunedReferences };
  return {
    prunedReferences,
    references: {
      constraints: withoutKeys(doc.constraints, droppedConstraints),
      constraintOrder: doc.constraintOrder.filter((id) => !droppedConstraints.has(id)),
      joints: withoutKeys(doc.joints, droppedJoints),
      jointOrder: doc.jointOrder.filter((id) => !droppedJoints.has(id)),
      driveRelations: withoutKeys(doc.driveRelations, droppedRelations),
      driveRelationOrder: doc.driveRelationOrder.filter((id) => !droppedRelations.has(id)),
    },
  };
}

/**
 * `doc` without `removed` entities: entities/order/selection, group memberships (groups left with
 * fewer than 2 members are dissolved and listed), and every constraint / joint / drive relation
 * that referenced a removed entity (counted in `prunedReferences`).
 * @pure
 */
export function withoutEntities(
  doc: CadDocument,
  removed: ReadonlySet<string>,
): { document: CadDocument; dissolvedGroups: string[]; prunedReferences: number } {
  const entities = { ...doc.entities };
  for (const id of removed) delete entities[id];
  const { nextGroups, dissolvedGroups } = pruneGroupMembers(doc.groups, removed);
  const { references, prunedReferences } = pruneReferences(doc, removed);
  const document: CadDocument = {
    ...doc,
    entities,
    order: doc.order.filter((id) => !removed.has(id)),
    selection: doc.selection.filter((id) => !removed.has(id)),
    groups: nextGroups,
    ...references,
  };
  return { document, dissolvedGroups, prunedReferences };
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

/** Number of constraint, joint and drive-relation records in `doc`. */
function referenceRecordCount(doc: CadDocument): number {
  return (
    Object.keys(doc.constraints).length +
    Object.keys(doc.joints).length +
    Object.keys(doc.driveRelations).length
  );
}

/** `referenceSuffix` for the records an entity-consuming command dropped between `before` and `after`. */
export function referenceLossSuffix(before: CadDocument, after: CadDocument): string {
  return referenceSuffix(Math.max(0, referenceRecordCount(before) - referenceRecordCount(after)));
}

/** Summary fragment naming how many constraints/joints/drive relations a deletion removed. */
export function referenceSuffix(prunedReferences: number): string {
  return prunedReferences > 0
    ? ` Also removed ${prunedReferences} constraint/joint/drive record(s) that referenced it.`
    : '';
}
