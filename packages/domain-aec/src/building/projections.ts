/** Read-only views of the `building` slice for core (BCF export): the IFC GlobalId of the element behind an entity. */

import type { DocumentProjections } from '@core/plugins/plugin';
import { ifcGuid } from '@lib/ifcGuid';
import type { BuildingModel } from './types';

const ownerIndex = new WeakMap<BuildingModel['elements'], ReadonlyMap<string, string>>();

/** Entity id -> owning element id (an element is its own key too), memoised per elements record. */
function ownersOf(elements: BuildingModel['elements']): ReadonlyMap<string, string> {
  const known = ownerIndex.get(elements);
  if (known !== undefined) return known;
  const index = new Map<string, string>();
  for (const element of Object.values(elements)) {
    index.set(element.id, element.id);
    for (const entityId of element.entityIds) index.set(entityId, element.id);
  }
  ownerIndex.set(elements, index);
  return index;
}

/**
 * GlobalId the IFC export writes for the element that owns `entityId` (`ifcGuid('<building uid>:<element id>')`, the seed of `context.guid`).
 * @failure no building, or no element lists the entity -> undefined
 */
const ifcGuidOfEntity: NonNullable<DocumentProjections['ifcGuid']> = (doc, entityId) => {
  const building = doc.building;
  if (building === undefined) return undefined;
  const owner = ownersOf(building.elements).get(entityId);
  return owner === undefined ? undefined : ifcGuid(`${building.uid ?? 'llull'}:${owner}`);
};

export const buildingProjections: DocumentProjections = { ifcGuid: ifcGuidOfEntity };
