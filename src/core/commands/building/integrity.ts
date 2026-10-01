/**
 * Keeps evaluated building geometry consistent with the building model (architecture L4/L8).
 * @layer core/commands/building
 */

import type { CadDocument } from '../../model/types';

function elementOf(tags: ReadonlyArray<string> | undefined): string | null {
  const tag = tags?.find((candidate) => candidate.startsWith('element:'));
  return tag ? tag.slice('element:'.length) : null;
}

/**
 * @pure
 * @returns ids of building elements whose generated entities `next` edited without going
 *          through a building command (empty when the edit is legal)
 */
export function editedBuildingElements(previous: CadDocument, next: CadDocument): string[] {
  if (next.building !== previous.building || previous.building === undefined) return [];
  if (next.entities === previous.entities) return [];
  const edited = new Set<string>();
  for (const element of Object.values(previous.building.elements)) {
    for (const id of element.entityIds) {
      if (next.entities[id] !== previous.entities[id]) edited.add(element.id);
    }
  }
  return [...edited];
}

/** Element id an evaluated entity belongs to, from its `element:<id>` tag. */
export function buildingElementOf(document: CadDocument, entityId: string): string | null {
  return elementOf(document.entities[entityId]?.tags);
}
