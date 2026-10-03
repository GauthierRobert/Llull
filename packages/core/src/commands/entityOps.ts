import type { CadDocument, Entity } from '../model/types';

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
