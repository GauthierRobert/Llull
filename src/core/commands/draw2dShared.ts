import type { CadDocument, Entity } from '../model/types';

/** Clone the document shallowly with a new entity added. Keeps commands pure. */
export function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}
/** Format a number compactly for the summary string. */
export function fmtN(v: number): string {
  return parseFloat(v.toFixed(4)).toString();
}
