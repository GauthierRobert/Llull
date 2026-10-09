/**
 * Civil regeneration: evaluates every civil object into entities and replaces the stale ones.
 * @layer domain-aec/civil
 */

import type { CadDocument, Entity } from '@core/model/types';
import type { CivilModel, CivilObject } from '@core/model/civil';
import { ensureCivilLayers } from './entities';
import { evaluatePointGroup, evaluateSurface } from './surfaceEvaluate';
import { evaluatePlatform } from './platformEvaluate';
import { evaluateAlignment } from './alignmentEvaluate';
import { evaluateManhole, evaluatePipe } from './drainageEvaluate';
import type { CivilContext } from './context';

function evaluateObject(context: CivilContext, object: CivilObject): Entity[] {
  switch (object.category) {
    case 'pointGroup':
      return evaluatePointGroup(context, object);
    case 'surface':
      return evaluateSurface(context, object);
    case 'platform':
      return evaluatePlatform(context, object);
    case 'alignment':
      return evaluateAlignment(context, object);
    case 'manhole':
      return evaluateManhole(context, object);
    case 'pipe':
      return evaluatePipe(context, object);
  }
}

/**
 * Replaces all previously evaluated civil entities with a fresh evaluation of `civil`.
 * @pure
 * @returns the new document; each object's `entityIds` lists the entities generated for it
 */
export function regenerateCivil(doc: CadDocument, civil: CivilModel): CadDocument {
  const stale = new Set<string>();
  for (const object of Object.values(doc.civil?.objects ?? {})) {
    for (const id of object.entityIds) stale.add(id);
  }
  const entities: Record<string, Entity> = {};
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (!stale.has(id)) entities[id] = entity;
  }
  const order = doc.order.filter((id) => !stale.has(id));
  const context: CivilContext = { doc, civil };
  const objects: Record<string, CivilObject> = {};
  const usedLayers = new Set<string>();
  for (const id of civil.order) {
    const object = civil.objects[id];
    if (!object) continue;
    const generated = evaluateObject(context, object);
    for (const entity of generated) {
      entities[entity.id] = entity;
      order.push(entity.id);
      usedLayers.add(entity.layerId);
    }
    objects[id] = { ...object, entityIds: generated.map((entity) => entity.id) };
  }
  const { layers, layerOrder } = ensureCivilLayers(doc.layers, doc.layerOrder, usedLayers);
  return {
    ...doc,
    entities,
    order,
    layers,
    layerOrder,
    selection: doc.selection.filter((id) => entities[id] !== undefined),
    civil: { ...civil, objects },
  };
}
