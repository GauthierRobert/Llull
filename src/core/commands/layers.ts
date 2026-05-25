/**
 * Layer management commands.
 *
 * Locked-layer policy:
 *   A locked layer rejects mutations that originate FROM that layer's entities.
 *   Specifically, `set_entity_layer` refuses to move an entity off a locked layer —
 *   this prevents accidental edits to locked content.  Moving an entity ON TO a
 *   locked layer is allowed (the entity simply becomes harder to edit once there).
 *   Commands that mutate layers themselves (rename, visibility, lock, delete) do NOT
 *   require the layer to be unlocked — layer-level operations are always permitted.
 *   Broader enforcement (blocking geometry edits to entities on locked layers) is a
 *   cross-cutting concern left for a follow-up.
 *
 * @layer core/commands
 */

import type { Layer } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';

// ---------------------------------------------------------------------------
// add_layer
// ---------------------------------------------------------------------------

interface AddLayerParams {
  name: string;
  color?: string;
}

/**
 * @command add_layer
 * @pure
 * @layer core/commands
 * @affects creates 1 new Layer; affected = [newLayerId]
 * @invariant new layer is visible, unlocked, appended to layerOrder
 * @failure empty name -> no-op, affected:[]
 */
export const addLayer: CommandDefinition<AddLayerParams> = {
  name: 'add_layer',
  description:
    'Create a new layer with the given name and append it to the layer order. ' +
    'Returns the new layer id in affected. The layer starts visible and unlocked.',
  paramsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Human-readable name for the new layer, e.g. "Walls". Must be non-empty.',
      },
      color: {
        type: 'string',
        description:
          'Optional hex color string for the layer, e.g. "#ff0000". ' +
          'Used by the UI to tint layer contents. Omit to leave unset.',
      },
    },
    required: ['name'],
  },
  run: (doc, { name, color }): CommandResult => {
    const trimmed = name.trim();
    if (!trimmed) {
      return {
        document: doc,
        summary: 'add_layer requires a non-empty name.',
        affected: [],
      };
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
      document: {
        ...doc,
        layers: { ...doc.layers, [id]: layer },
        layerOrder: [...doc.layerOrder, id],
      },
      summary: `Created layer ${id} ("${trimmed}").`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// rename_layer
// ---------------------------------------------------------------------------

interface RenameLayerParams {
  id: string;
  name: string;
}

/**
 * @command rename_layer
 * @pure
 * @layer core/commands
 * @affects updates name on the target layer; affected = [id]
 * @invariant layer geometry/visibility/lock state is unchanged
 * @failure missing id -> no-op, affected:[]; empty name -> no-op, affected:[]
 */
export const renameLayer: CommandDefinition<RenameLayerParams> = {
  name: 'rename_layer',
  description:
    'Rename a layer. Does not affect visibility, lock state, or entities. ' +
    'Graceful no-op if the layer id does not exist or the name is empty.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the layer to rename.' },
      name: {
        type: 'string',
        description: 'New display name for the layer. Must be non-empty.',
      },
    },
    required: ['id', 'name'],
  },
  run: (doc, { id, name }): CommandResult => {
    const layer = doc.layers[id];
    if (!layer) {
      return {
        document: doc,
        summary: `No layer ${id} — rename_layer is a no-op.`,
        affected: [],
      };
    }

    const trimmed = name.trim();
    if (!trimmed) {
      return {
        document: doc,
        summary: 'rename_layer requires a non-empty name.',
        affected: [],
      };
    }

    const prevName = layer.name;
    return {
      document: {
        ...doc,
        layers: {
          ...doc.layers,
          [id]: { ...layer, name: trimmed },
        },
      },
      summary: `Layer ${id}: renamed "${prevName}" → "${trimmed}".`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// set_layer_visibility
// ---------------------------------------------------------------------------

interface SetLayerVisibilityParams {
  id: string;
  visible: boolean;
}

/**
 * @command set_layer_visibility
 * @pure
 * @layer core/commands
 * @affects updates visible flag on the target layer; affected = [id]
 * @invariant layer name/lock state and entities are unchanged
 * @failure missing id -> no-op, affected:[]
 */
export const setLayerVisibility: CommandDefinition<SetLayerVisibilityParams> = {
  name: 'set_layer_visibility',
  description:
    'Show or hide a layer. Hidden layers are not rendered in the viewport. ' +
    'Graceful no-op if the layer id does not exist.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the layer to change.' },
      visible: {
        type: 'boolean',
        description: 'true to make the layer visible; false to hide it.',
      },
    },
    required: ['id', 'visible'],
  },
  run: (doc, { id, visible }): CommandResult => {
    const layer = doc.layers[id];
    if (!layer) {
      return {
        document: doc,
        summary: `No layer ${id} — set_layer_visibility is a no-op.`,
        affected: [],
      };
    }

    return {
      document: {
        ...doc,
        layers: {
          ...doc.layers,
          [id]: { ...layer, visible },
        },
      },
      summary: `Layer ${id} ("${layer.name}"): visible = ${visible}.`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// set_layer_lock
// ---------------------------------------------------------------------------

interface SetLayerLockParams {
  id: string;
  locked: boolean;
}

/**
 * @command set_layer_lock
 * @pure
 * @layer core/commands
 * @affects updates locked flag on the target layer; affected = [id]
 * @invariant layer name/visibility and entities are unchanged
 * @failure missing id -> no-op, affected:[]
 */
export const setLayerLock: CommandDefinition<SetLayerLockParams> = {
  name: 'set_layer_lock',
  description:
    'Lock or unlock a layer. Entities on a locked layer cannot have their layer reassigned ' +
    'via set_entity_layer. (Note: locking does not yet block geometry edits to those entities — ' +
    'broader lock enforcement is a planned follow-up.) Graceful no-op if the layer id does not exist.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the layer to lock or unlock.' },
      locked: {
        type: 'boolean',
        description: 'true to lock the layer; false to unlock it.',
      },
    },
    required: ['id', 'locked'],
  },
  run: (doc, { id, locked }): CommandResult => {
    const layer = doc.layers[id];
    if (!layer) {
      return {
        document: doc,
        summary: `No layer ${id} — set_layer_lock is a no-op.`,
        affected: [],
      };
    }

    return {
      document: {
        ...doc,
        layers: {
          ...doc.layers,
          [id]: { ...layer, locked },
        },
      },
      summary: `Layer ${id} ("${layer.name}"): locked = ${locked}.`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// set_entity_layer
// ---------------------------------------------------------------------------

interface SetEntityLayerParams {
  entityId: string;
  layerId: string;
}

/**
 * @command set_entity_layer
 * @pure
 * @layer core/commands
 * @affects updates layerId on the target entity; affected = [entityId]
 * @invariant entity geometry is unchanged; entity.layerId ∈ doc.layers after the op
 * @failure missing entityId -> no-op; missing layerId -> no-op;
 *          entity's CURRENT layer is locked -> reject (locked-layer guard)
 */
export const setEntityLayer: CommandDefinition<SetEntityLayerParams> = {
  name: 'set_entity_layer',
  description:
    'Move an entity to a different layer by updating its layerId. ' +
    'Graceful no-op if the entity or target layer does not exist. ' +
    'Rejected (graceful no-op) if the entity currently resides on a LOCKED layer — ' +
    'unlock the source layer first before reassigning its entities.',
  paramsSchema: {
    type: 'object',
    properties: {
      entityId: {
        type: 'string',
        description: 'Id of the entity to reassign to a different layer.',
      },
      layerId: {
        type: 'string',
        description: 'Id of the destination layer. Must exist in the document.',
      },
    },
    required: ['entityId', 'layerId'],
  },
  run: (doc, { entityId, layerId }): CommandResult => {
    const entity = doc.entities[entityId];
    if (!entity) {
      return {
        document: doc,
        summary: `No entity ${entityId} — set_entity_layer is a no-op.`,
        affected: [],
      };
    }

    const targetLayer = doc.layers[layerId];
    if (!targetLayer) {
      return {
        document: doc,
        summary: `No layer ${layerId} — set_entity_layer is a no-op.`,
        affected: [],
      };
    }

    // Locked-layer guard: refuse to move an entity off a locked source layer.
    const sourceLayer = doc.layers[entity.layerId];
    if (sourceLayer?.locked) {
      return {
        document: doc,
        summary:
          `Entity ${entityId} is on locked layer ${entity.layerId} ("${sourceLayer.name}"). ` +
          `Unlock the source layer before reassigning its entities.`,
        affected: [],
      };
    }

    return {
      document: {
        ...doc,
        entities: {
          ...doc.entities,
          [entityId]: { ...entity, layerId },
        },
      },
      summary: `Entity ${entityId}: moved from layer ${entity.layerId} to ${layerId} ("${targetLayer.name}").`,
      affected: [entityId],
    };
  },
};

// ---------------------------------------------------------------------------
// delete_layer
// ---------------------------------------------------------------------------

interface DeleteLayerParams {
  id: string;
}

/**
 * @command delete_layer
 * @pure
 * @layer core/commands
 * @affects removes 1 layer from doc.layers and doc.layerOrder; affected = [id];
 *          all entities on the deleted layer are reassigned to DEFAULT_LAYER_ID
 * @invariant DEFAULT_LAYER_ID cannot be deleted; entity count is unchanged
 * @failure missing id -> no-op, affected:[]; id === DEFAULT_LAYER_ID -> no-op, affected:[]
 */
export const deleteLayer: CommandDefinition<DeleteLayerParams> = {
  name: 'delete_layer',
  description:
    'Delete a layer by id. All entities that were on the deleted layer are automatically ' +
    'reassigned to the default layer (layer-default). ' +
    'The default layer cannot be deleted. ' +
    'Graceful no-op if the layer id does not exist.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Id of the layer to delete. Must not be "layer-default" (the default layer). ' +
          'Must exist in the document.',
      },
    },
    required: ['id'],
  },
  run: (doc, { id }): CommandResult => {
    if (id === DEFAULT_LAYER_ID) {
      return {
        document: doc,
        summary: `Cannot delete the default layer (${DEFAULT_LAYER_ID}).`,
        affected: [],
      };
    }

    const layer = doc.layers[id];
    if (!layer) {
      return {
        document: doc,
        summary: `No layer ${id} — delete_layer is a no-op.`,
        affected: [],
      };
    }

    // Reassign orphaned entities to the default layer.
    const nextEntities = { ...doc.entities };
    let reassignedCount = 0;
    for (const entityId of Object.keys(nextEntities)) {
      const entity = nextEntities[entityId];
      if (entity && entity.layerId === id) {
        nextEntities[entityId] = { ...entity, layerId: DEFAULT_LAYER_ID };
        reassignedCount++;
      }
    }

    // Remove layer from layers map.
    const nextLayers = { ...doc.layers };
    delete nextLayers[id];

    // Remove layer from layerOrder.
    const nextLayerOrder = doc.layerOrder.filter((lid) => lid !== id);

    return {
      document: {
        ...doc,
        entities: nextEntities,
        layers: nextLayers,
        layerOrder: nextLayerOrder,
      },
      summary:
        `Deleted layer ${id} ("${layer.name}"). ` +
        `${reassignedCount} entity(s) reassigned to default layer ${DEFAULT_LAYER_ID}.`,
      affected: [id],
    };
  },
};
