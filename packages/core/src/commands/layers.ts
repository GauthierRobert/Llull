/**
 * Layer management commands.
 * Locked-layer policy: only `set_entity_layer` honours locks (it refuses to move an entity OFF a
 * locked layer); layer operations and geometry edits are never blocked.
 *
 * @layer core/commands
 */

import type { CadDocument, Layer } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { noop } from './noop';
import { isHexColor } from '../lib/isHexColor';
import { replaceEntity } from './entityOps';

const withLayer = (doc: CadDocument, layer: Layer): CadDocument => ({
  ...doc,
  layers: { ...doc.layers, [layer.id]: layer },
});

/** `layer` `id` with boolean `flag` set to `value`; a missing layer is a no-op naming `command`. */
function setLayerFlag(
  doc: CadDocument,
  command: string,
  id: string,
  flag: 'visible' | 'locked',
  value: boolean,
): CommandResult {
  const layer = doc.layers[id];
  if (!layer) return noop(doc, `No layer ${id} — ${command} is a no-op.`);
  return {
    document: withLayer(doc, { ...layer, [flag]: value }),
    summary: `Layer ${id} ("${layer.name}"): ${flag} = ${value}.`,
    affected: [id],
  };
}

/**
 * @command add_layer
 * @pure
 * @layer core/commands
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
    name: z
      .string()
      .describe('Human-readable name for the new layer, e.g. "Walls". Must be non-empty.'),
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
    if (!trimmed) {
      return noop(doc, 'add_layer requires a non-empty name.');
    }

    if (color !== undefined && !isHexColor(color)) {
      return noop(doc, `add_layer: color must be a #rrggbb hex string (got "${color}").`);
    }

    const id = nextId('layer');
    const layer: Layer = {
      id,
      name: trimmed,
      visible: true,
      locked: false,
      ...(color !== undefined ? { color } : {}),
    };

    return {
      document: { ...withLayer(doc, layer), layerOrder: [...doc.layerOrder, id] },
      summary: `Created layer ${id} ("${trimmed}").`,
      affected: [id],
    };
  },
});

/**
 * @command rename_layer
 * @pure
 * @layer core/commands
 * @affects updates name on the target layer; affected = [id]
 * @invariant layer geometry/visibility/lock state is unchanged
 * @failure missing id -> no-op, affected:[]; empty name -> no-op, affected:[]
 */
export const renameLayer = defineCommand({
  name: 'rename_layer',
  annotations: { idempotent: true },
  description:
    'Rename a layer. Does not affect visibility, lock state, or entities. ' +
    'Graceful no-op if the layer id does not exist or the name is empty.',
  params: z.object({
    id: z.string().describe('Id of the layer to rename.'),
    name: z.string().describe('New display name for the layer. Must be non-empty.'),
  }),
  run: (doc, { id, name }): CommandResult => {
    const layer = doc.layers[id];
    if (!layer) {
      return noop(doc, `No layer ${id} — rename_layer is a no-op.`);
    }

    const trimmed = name.trim();
    if (!trimmed) {
      return noop(doc, 'rename_layer requires a non-empty name.');
    }

    const prevName = layer.name;
    return {
      document: withLayer(doc, { ...layer, name: trimmed }),
      summary: `Layer ${id}: renamed "${prevName}" → "${trimmed}".`,
      affected: [id],
    };
  },
});

/**
 * @command set_layer_visibility
 * @pure
 * @layer core/commands
 * @affects updates visible flag on the target layer; affected = [id]
 * @invariant layer name/lock state and entities are unchanged
 * @failure missing id -> no-op, affected:[]
 */
export const setLayerVisibility = defineCommand({
  name: 'set_layer_visibility',
  annotations: { idempotent: true },
  description:
    'Show or hide a layer. Hidden layers are not rendered in the viewport. ' +
    'Graceful no-op if the layer id does not exist.',
  params: z.object({
    id: z.string().describe('Id of the layer to change.'),
    visible: z.boolean().describe('true to make the layer visible; false to hide it.'),
  }),
  run: (doc, { id, visible }): CommandResult =>
    setLayerFlag(doc, 'set_layer_visibility', id, 'visible', visible),
});

/**
 * @command set_layer_lock
 * @pure
 * @layer core/commands
 * @affects updates locked flag on the target layer; affected = [id]
 * @invariant layer name/visibility and entities are unchanged
 * @failure missing id -> no-op, affected:[]
 */
export const setLayerLock = defineCommand({
  name: 'set_layer_lock',
  annotations: { idempotent: true },
  description:
    'Lock or unlock a layer. Entities on a locked layer cannot have their layer reassigned ' +
    'via set_entity_layer. (Note: locking does not yet block geometry edits to those entities — ' +
    'broader lock enforcement is a planned follow-up.) Graceful no-op if the layer id does not exist.',
  params: z.object({
    id: z.string().describe('Id of the layer to lock or unlock.'),
    locked: z.boolean().describe('true to lock the layer; false to unlock it.'),
  }),
  run: (doc, { id, locked }): CommandResult =>
    setLayerFlag(doc, 'set_layer_lock', id, 'locked', locked),
});

/**
 * @command set_entity_layer
 * @pure
 * @layer core/commands
 * @affects updates layerId on the target entity; affected = [entityId]
 * @invariant entity geometry is unchanged; entity.layerId ∈ doc.layers after the op
 * @failure missing entityId -> no-op; missing layerId -> no-op;
 *          entity's CURRENT layer is locked -> reject (locked-layer guard)
 */
export const setEntityLayer = defineCommand({
  name: 'set_entity_layer',
  annotations: { idempotent: true },
  description:
    'Move an entity to a different layer by updating its layerId. ' +
    'Graceful no-op if the entity or target layer does not exist. ' +
    'Rejected (graceful no-op) if the entity currently resides on a LOCKED layer — ' +
    'unlock the source layer first before reassigning its entities.',
  params: z.object({
    entityId: z.string().describe('Id of the entity to reassign to a different layer.'),
    layerId: z.string().describe('Id of the destination layer. Must exist in the document.'),
  }),
  run: (doc, { entityId, layerId }): CommandResult => {
    const entity = doc.entities[entityId];
    if (!entity) {
      return noop(doc, `No entity ${entityId} — set_entity_layer is a no-op.`);
    }

    const targetLayer = doc.layers[layerId];
    if (!targetLayer) {
      return noop(doc, `No layer ${layerId} — set_entity_layer is a no-op.`);
    }

    const sourceLayer = doc.layers[entity.layerId];
    if (sourceLayer?.locked) {
      return noop(
        doc,
        `Entity ${entityId} is on locked layer ${entity.layerId} ("${sourceLayer.name}"). ` +
          `Unlock the source layer before reassigning its entities.`,
      );
    }

    return {
      document: replaceEntity(doc, { ...entity, layerId }),
      summary: `Entity ${entityId}: moved from layer ${entity.layerId} to ${layerId} ("${targetLayer.name}").`,
      affected: [entityId],
    };
  },
});

/**
 * @command delete_layer
 * @pure
 * @layer core/commands
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
    'reassigned to the default layer (layer-default). ' +
    'The default layer cannot be deleted. ' +
    'Graceful no-op if the layer id does not exist.',
  params: z.object({
    id: z
      .string()
      .describe(
        'Id of the layer to delete. Must not be "layer-default" (the default layer). ' +
          'Must exist in the document.',
      ),
  }),
  run: (doc, { id }): CommandResult => {
    if (id === DEFAULT_LAYER_ID) {
      return noop(doc, `Cannot delete the default layer (${DEFAULT_LAYER_ID}).`);
    }

    const layer = doc.layers[id];
    if (!layer) {
      return noop(doc, `No layer ${id} — delete_layer is a no-op.`);
    }

    const orphans = Object.values(doc.entities).filter((entity) => entity.layerId === id);
    const nextLayers = Object.fromEntries(Object.entries(doc.layers).filter(([lid]) => lid !== id));

    return {
      document: {
        ...orphans.reduce(
          (next, entity) => replaceEntity(next, { ...entity, layerId: DEFAULT_LAYER_ID }),
          doc,
        ),
        layers: nextLayers,
        layerOrder: doc.layerOrder.filter((lid) => lid !== id),
      },
      summary:
        `Deleted layer ${id} ("${layer.name}"). ` +
        `${orphans.length} entity(s) reassigned to default layer ${DEFAULT_LAYER_ID}.`,
      affected: [id],
    };
  },
});
