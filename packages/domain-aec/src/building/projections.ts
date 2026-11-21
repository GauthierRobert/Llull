/** Read-only views of the `building` slice for core (BCF export): the IFC GlobalId of the element behind an entity. */

import type { DocumentProjections } from '@core/plugins/plugin';
import { ifcGuid } from '@lib/ifcGuid';
import type { BuildingModel } from './types';

/**
 * Categories whose IFC product is seeded by exactly the element id (`context.guid(element.id)`). Not listed: `pipe` (IFC4X3 writes segments / bends under
 * `<id>:seg:k` / `:bend:k`), `connection` (parts and bolts under `<id>:<part>`), `grid` (never exported) and the categories not verified against the exporter.
 */
const PRODUCT_SEEDED_BY_ID: ReadonlySet<string> = new Set([
  'wall',
  'door',
  'window',
  'slab',
  'column',
  'beam',
  'stair',
  'room',
  'equipment',
  'pipeSupport',
  'plate',
]);

type Elements = BuildingModel['elements'];

const ownerIndex = new WeakMap<Elements, ReadonlyMap<string, string>>();

/** Entity id -> owning element id (an element is its own key too) for the listed categories, memoised per elements record. */
function ownersOf(elements: Elements): ReadonlyMap<string, string> {
  const known = ownerIndex.get(elements);
  if (known !== undefined) return known;
  const index = new Map<string, string>();
  for (const element of Object.values(elements)) {
    if (!PRODUCT_SEEDED_BY_ID.has(element.category)) continue;
    index.set(element.id, element.id);
    for (const entityId of element.entityIds) index.set(entityId, element.id);
  }
  ownerIndex.set(elements, index);
  return index;
}

/**
 * GlobalId the IFC export writes for the element that owns `entityId` (`ifcGuid('<building uid>:<element id>')`, the seed of `context.guid`).
 * @failure no building, no element lists the entity, or its category is not seeded by the element id -> undefined
 * @invariant an element a scoped export leaves out (plant.scope) still gets its GlobalId: it names no product in that file
 */
const ifcGuidOfEntity: NonNullable<DocumentProjections['ifcGuid']> = (doc, entityId) => {
  const building = doc.building;
  if (building === undefined) return undefined;
  const owner = ownersOf(building.elements).get(entityId);
  return owner === undefined ? undefined : ifcGuid(`${building.uid ?? 'llull'}:${owner}`);
};

export const buildingProjections: DocumentProjections = { ifcGuid: ifcGuidOfEntity };
