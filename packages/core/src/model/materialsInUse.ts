/** Which materials a document actually uses: the ones assigned to an entity, including the entities inside component definitions. */

import type { CadDocument, Entity } from './types';

/**
 * Material name → ids of the entities that carry it.
 * @invariant without `entityIds` every entity of the document and of its components is scanned; with them only those entities of the document
 */
export function materialsInUse(doc: CadDocument, entityIds?: readonly string[]): Map<string, string[]> {
  const entities: Entity[] =
    entityIds === undefined
      ? [...Object.values(doc.entities), ...Object.values(doc.components).flatMap((component) => Object.values(component.entities))]
      : entityIds.flatMap((id) => (doc.entities[id] !== undefined ? [doc.entities[id]] : []));
  const users = new Map<string, string[]>();
  for (const entity of entities) {
    if (entity.materialId === undefined) continue;
    const list = users.get(entity.materialId);
    if (list === undefined) users.set(entity.materialId, [entity.id]);
    else list.push(entity.id);
  }
  return users;
}
