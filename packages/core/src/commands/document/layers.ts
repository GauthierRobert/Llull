/**
 * Layer management commands. Locked-layer policy: only `set_entity_layer` honours locks (it refuses to move an entity OFF a locked layer);
 * layer operations and geometry edits are never blocked.
 */

import { type CadDocument, type Layer, DEFAULT_LAYER_ID } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { nextId } from '../../lib/id';
import { changed, noop } from '../noop';
import { isHexColor } from '../../lib/isHexColor';
import { replaceEntitiesById, replaceEntity } from '../entity/entityOps';

const withLayer = (doc: CadDocument, layer: Layer): CadDocument => ({ ...doc, layers: { ...doc.layers, [layer.id]: layer } });

/**
 * @affects creates 1 new Layer; affected = [newLayerId]
 * @invariant new layer is visible, unlocked, appended to layerOrder
 * @failure empty name or non-#rrggbb color -> no-op, affected:[]
 */
export const addLayer = defineCommand({
  name: 'add_layer',
  description:
    'Create a new layer with the given name and append it to the layer order. ' +
    'Returns the new layer id in affected. The layer starts visible and unlocked.',
  params: z.object({
    name: z.string().describe('Human-readable name for the new layer, e.g. "Walls". Must be non-empty.'),
    color: z
      .string()
      .optional()
      .describe(
        'Optional hex color string #rrggbb for the layer, e.g. "#ff0000"; any other format is rejected. ' +
          'Used by the UI to tint layer contents. Omit to leave unset.',
      ),
  }),
  run: (doc, { name, color }): CommandResult => {
    const trimmed = name.trim();
    if (!trimmed) return noop(doc, 'add_layer requires a non-empty name.');
    if (color !== undefined && !isHexColor(color)) return noop(doc, `add_layer: color must be a #rrggbb hex string (got "${color}").`);
    const id = nextId('layer');
    const layer: Layer = { id, name: trimmed, visible: true, locked: false, ...(color !== undefined ? { color } : {}) };
    return changed({ ...withLayer(doc, layer), layerOrder: [...doc.layerOrder, id] }, `Created layer ${id} ("${trimmed}").`, [id]);
  },
});

/**
 * @affects updates the given fields (name, visible, locked, color) on the target layer; affected = [id]
 * @invariant fields not given, and entities, are unchanged
 * @failure missing id, no field given, empty name, or non-#rrggbb color -> no-op, affected:[]
 */
export const updateLayer = defineCommand({
  name: 'update_layer',
  annotations: { idempotent: true },
  description:
    'Change one or more properties of a layer: rename it (name), show or hide it (visible; hidden ' +
    'layers are not rendered), lock or unlock it (locked; entities on a locked layer cannot be ' +
    'reassigned via set_entity_layer, but geometry edits are not blocked), or tint it (color). ' +
    'Give at least one field; fields not given are kept. Entities are not affected. ' +
    'Graceful no-op if the layer id does not exist, no field is given, the name is empty or the color is not #rrggbb.',
  params: z.object({
    id: z.string().describe('Id of the layer to change.'),
    name: z.string().describe('New display name for the layer. Must be non-empty.').optional(),
    visible: z.boolean().describe('true to make the layer visible; false to hide it.').optional(),
    locked: z.boolean().describe('true to lock the layer; false to unlock it.').optional(),
    color: z.string().describe('New layer tint as a hex string #rrggbb, e.g. "#ff0000"; any other format is rejected.').optional(),
  }),
  run: (doc, { id, name, visible, locked, color }): CommandResult => {
    const layer = doc.layers[id];
    if (!layer) return noop(doc, `No layer ${id} — update_layer is a no-op.`);
    const trimmed = name?.trim();
    if (trimmed === '') return noop(doc, 'update_layer requires a non-empty name.');
    if (color !== undefined && !isHexColor(color)) return noop(doc, `update_layer: color must be a #rrggbb hex string (got "${color}").`);
    const patch: Partial<Layer> = {
      ...(trimmed === undefined ? {} : { name: trimmed }),
      ...(visible === undefined ? {} : { visible }),
      ...(locked === undefined ? {} : { locked }),
      ...(color === undefined ? {} : { color }),
    };
    const fields = Object.keys(patch);
    if (fields.length === 0) return noop(doc, `update_layer: give at least one of name, visible, locked, color for ${id}.`);
    const changes = Object.entries(patch).map(([field, value]) => `${field} = ${JSON.stringify(value)}`);
    return changed(withLayer(doc, { ...layer, ...patch }), `Layer ${id} ("${layer.name}"): ${changes.join(', ')}.`, [id]);
  },
});

/**
 * @affects updates layerId on the target entity; affected = [entityId]
 * @invariant entity geometry is unchanged; entity.layerId ∈ doc.layers after the op
 * @failure missing entityId -> no-op; missing layerId -> no-op;
 *          entity's CURRENT layer is locked -> reject (locked-layer guard)
 */
export const setEntityLayer = defineCommand({
  name: 'set_entity_layer',
  annotations: { idempotent: true },
  description:
    'Move an entity to a different layer by updating its layerId. Graceful no-op if the entity or target layer does not exist. ' +
    'Rejected (graceful no-op) if the entity currently resides on a LOCKED layer — ' +
    'unlock the source layer first before reassigning its entities.',
  params: z.object({
    entityId: z.string().describe('Id of the entity to reassign to a different layer.'),
    layerId: z.string().describe('Id of the destination layer. Must exist in the document.'),
  }),
  run: (doc, { entityId, layerId }): CommandResult => {
    const entity = doc.entities[entityId];
    if (!entity) return noop(doc, `No entity ${entityId} — set_entity_layer is a no-op.`);
    const targetLayer = doc.layers[layerId];
    if (!targetLayer) return noop(doc, `No layer ${layerId} — set_entity_layer is a no-op.`);
    const sourceLayer = doc.layers[entity.layerId];
    if (sourceLayer?.locked)
      return noop(
        doc,
        `Entity ${entityId} is on locked layer ${entity.layerId} ("${sourceLayer.name}"). ` +
          `Unlock the source layer before reassigning its entities.`,
      );
    return changed(
      replaceEntity(doc, { ...entity, layerId }),
      `Entity ${entityId}: moved from layer ${entity.layerId} to ${layerId} ("${targetLayer.name}").`,
      [entityId],
    );
  },
});

/**
 * @affects removes 1 layer from doc.layers and doc.layerOrder; affected = [id];
 *          all entities on the deleted layer are reassigned to DEFAULT_LAYER_ID
 * @invariant DEFAULT_LAYER_ID cannot be deleted; entity count is unchanged
 * @failure missing id -> no-op, affected:[]; id === DEFAULT_LAYER_ID -> no-op, affected:[]
 */
export const deleteLayer = defineCommand({
  name: 'delete_layer',
  annotations: { destructive: true },
  description:
    'Delete a layer by id. All entities that were on the deleted layer are automatically ' +
    'reassigned to the default layer (layer-default). The default layer cannot be deleted. ' +
    'Graceful no-op if the layer id does not exist.',
  params: z.object({
    id: z.string().describe('Id of the layer to delete. Must not be "layer-default" (the default layer). Must exist in the document.'),
  }),
  run: (doc, { id }): CommandResult => {
    if (id === DEFAULT_LAYER_ID) return noop(doc, `Cannot delete the default layer (${DEFAULT_LAYER_ID}).`);
    const layer = doc.layers[id];
    if (!layer) return noop(doc, `No layer ${id} — delete_layer is a no-op.`);
    const orphans = Object.values(doc.entities).filter((entity) => entity.layerId === id);
    const reassigned = replaceEntitiesById(
      doc,
      orphans.map((entity) => ({ ...entity, layerId: DEFAULT_LAYER_ID })),
    );
    return {
      document: {
        ...reassigned,
        layers: Object.fromEntries(Object.entries(doc.layers).filter(([lid]) => lid !== id)),
        layerOrder: doc.layerOrder.filter((lid) => lid !== id),
      },
      summary: `Deleted layer ${id} ("${layer.name}"). ` + `${orphans.length} entity(s) reassigned to default layer ${DEFAULT_LAYER_ID}.`,
      affected: [id],
    };
  },
});
