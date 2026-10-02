/**
 * Keeps evaluated building geometry consistent with the building model (architecture L4/L8).
 * @layer core/commands/building
 */

import type { CadDocument, Entity } from '@core/model/types';

function elementTag(entity: Entity | undefined): string | null {
  const tag = entity?.tags?.find((candidate) => candidate.startsWith('element:'));
  return tag ? tag.slice('element:'.length) : null;
}

function sameEntity(a: Entity | undefined, b: Entity | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
}

/**
 * @pure
 * @returns ids of building elements whose generated entities `next` changed, removed or copied
 *          without going through a building command (empty when the edit is legal). Commands that
 *          rebuild entity objects without changing them (e.g. solve_constraints) are not flagged.
 */
export function editedBuildingElements(previous: CadDocument, next: CadDocument): string[] {
  if (next.building !== previous.building || previous.building === undefined) return [];
  if (next.entities === previous.entities) return [];
  const edited = new Set<string>();
  const owned = new Set<string>();
  for (const element of Object.values(previous.building.elements)) {
    for (const id of element.entityIds) {
      owned.add(id);
      if (!sameEntity(next.entities[id], previous.entities[id])) edited.add(element.id);
    }
  }
  for (const [id, entity] of Object.entries(next.entities)) {
    if (owned.has(id) || previous.entities[id] !== undefined) continue;
    const element = elementTag(entity);
    if (entity.tags?.includes('bim') === true && element !== null) edited.add(element);
  }
  return [...edited];
}

/** Building element that generated `entityId` (verified against the element's entity list). */
export function buildingElementOf(document: CadDocument, entityId: string): string | null {
  const element = elementTag(document.entities[entityId]);
  if (element === null) return null;
  return document.building?.elements[element]?.entityIds.includes(entityId) === true
    ? element
    : null;
}
