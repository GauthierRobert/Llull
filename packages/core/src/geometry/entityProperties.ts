/** The core property bag of an entity and its merge with plugin providers (plant 09 VIS §3.3). Pure. */

import type { PropertyValue } from '../model/display';
import type { EntityPropertyProvider, PropertyBag } from '../model/entityProperties';
import { is2D, type CadDocument } from '../model/types';

/**
 * Core keys: `id`, `kind`, `is2D`, `layerId`, `layerName`, `name`, `materialId`, `componentId`, and `tag` (all tags, multi-valued).
 * @invariant {} for an unknown id; keys with no value are absent
 */
export function coreEntityProperties(doc: CadDocument, entityId: string): PropertyBag {
  const entity = doc.entities[entityId];
  if (entity === undefined) return {};
  const bag: Record<string, PropertyValue | readonly PropertyValue[]> = { id: entity.id, kind: entity.kind, is2D: is2D(entity) };
  bag['layerId'] = entity.layerId;
  const layer = doc.layers[entity.layerId];
  if (layer !== undefined) bag['layerName'] = layer.name;
  if (entity.name !== undefined) bag['name'] = entity.name;
  if (entity.tags !== undefined && entity.tags.length > 0) bag['tag'] = entity.tags;
  if (entity.materialId !== undefined) bag['materialId'] = entity.materialId;
  if ('componentId' in entity && typeof entity.componentId === 'string') bag['componentId'] = entity.componentId;
  return bag;
}

/**
 * Core keys merged under the providers' (in order); a provider cannot override a core key.
 * @invariant a provider's keys never replace a core key; a later provider adds keys, an earlier one wins ties
 */
export function entityPropertyBag(doc: CadDocument, entityId: string, providers: readonly EntityPropertyProvider[]): PropertyBag {
  const core = coreEntityProperties(doc, entityId);
  if (Object.keys(core).length === 0) return core;
  const merged: Record<string, PropertyValue | readonly PropertyValue[]> = {};
  for (const provider of [...providers].reverse()) Object.assign(merged, provider(doc, entityId));
  return Object.assign(merged, core);
}
