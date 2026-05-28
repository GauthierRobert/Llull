/**
 * Assembly commands: create_component, insert_instance, explode_instance.
 *
 * An assembly is a two-level structure:
 *   - A `Component` definition stores local-space entities (geometry), keyed by id.
 *   - An `InstanceEntity` places that component in the world via position/rotation/scale.
 *
 * Instances reference the component by id — they do NOT copy geometry. Editing the
 * component definition is immediately reflected in every instance.
 *
 * `expandInstance` bakes an instance into world-space entities for `explode_instance`.
 * Scene bounds (`scene.ts` `instanceBoundsFromDoc`) apply the SAME transform order
 * (scale → rotate-about-origin → translate) to each child's local-AABB corners — keep
 * the two in sync. The render tessellator does NOT yet expand instances (explode to
 * export); that is a tracked follow-up.
 *
 * @layer core/commands
 */

import type { Component, Entity, InstanceEntity, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { DEFAULT_LAYER_ID } from '../model/types';
import { nextId } from '../../lib/id';
import { applyEulerXYZ, isZeroRotation } from '@lib/eulerRotation';

// ---------------------------------------------------------------------------
// expandInstance — pure world-space bake helper
// ---------------------------------------------------------------------------

/**
 * Bake an instance into world-space copies of the component's entities.
 *
 * For each entity in `component.entities`, applies `instance.scale` (default [1,1,1]),
 * rotates by `instance.rotation` (XYZ Euler — the same convention as
 * `lib/eulerRotation.applyEulerXYZ` and the viewport), then translates by `instance.position`.
 * Each returned entity receives a fresh id from `nextId`.
 *
 * Callers: `explode_instance` (produces real entities), scene bounds, and the
 * render tessellator (recursion for the instance kind).
 *
 * @pure — returns new entities; does not mutate the input
 * @layer core/commands
 */
export function expandInstance(instance: InstanceEntity, component: Component): Entity[] {
  const scale: Vec3 = instance.scale ?? [1, 1, 1];
  const [sx, sy, sz] = scale;
  const rot = instance.rotation;
  const pos = instance.position;
  const hasRotation = !isZeroRotation(rot);

  return component.order
    .map((cid) => component.entities[cid])
    .filter((e): e is Entity => e !== undefined)
    .map((childEntity): Entity => {
      // 1. Apply scale to the component-local position.
      const localPos: Vec3 = [
        childEntity.position[0] * sx,
        childEntity.position[1] * sy,
        childEntity.position[2] * sz,
      ];

      // 2. Apply instance rotation around the component origin [0,0,0].
      const rotatedPos: Vec3 = hasRotation
        ? applyEulerXYZ(localPos, [0, 0, 0], rot)
        : localPos;

      // 3. Translate by the instance world position.
      const worldPos: Vec3 = [
        rotatedPos[0] + pos[0],
        rotatedPos[1] + pos[1],
        rotatedPos[2] + pos[2],
      ];

      // 4. Accumulate rotation (add Euler angles — approximate but consistent with the
      //    rest of the command layer which uses additive Euler).
      const worldRot: Vec3 = [
        childEntity.rotation[0] + rot[0],
        childEntity.rotation[1] + rot[1],
        childEntity.rotation[2] + rot[2],
      ];

      return {
        ...childEntity,
        id: nextId(childEntity.kind),
        position: worldPos,
        rotation: worldRot,
      } as Entity;
    });
}

// ---------------------------------------------------------------------------
// create_component
// ---------------------------------------------------------------------------

interface CreateComponentParams {
  /** Human-readable name for the new component. */
  name: string;
  /** Ids of existing document entities to promote into the component. Must contain at least 1 id. */
  entityIds: string[];
  /**
   * Optional explicit component id. When omitted a fresh id is generated.
   * Useful for deterministic tests or agent plans that need to reference the id immediately.
   */
  componentId?: string;
}

/**
 * @command create_component
 * @pure
 * @layer core/commands
 * @affects [instanceId] — the single InstanceEntity that replaces the promoted entities
 * @invariant component stored in doc.components; source entity ids removed from doc.entities/order
 * @invariant instance at position [0,0,0] references the new component
 * @failure any entityId missing -> no-op, affected:[]
 * @failure entityIds empty -> no-op, affected:[]
 */
export const createComponent: CommandDefinition<CreateComponentParams> = {
  name: 'create_component',
  description:
    'Promote a set of existing entities into a reusable Component definition. ' +
    'The source entities are removed from the document and replaced by a single InstanceEntity ' +
    'at position [0,0,0] referencing the new component. ' +
    'All ids in entityIds must exist in the document; any missing id causes a graceful no-op. ' +
    'Returns the new instance id in affected.',
  paramsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Human-readable name for the component, e.g. "Wheel". Used as the component label.',
      },
      entityIds: {
        type: 'array',
        description:
          'Ids of existing document entities to collect into the component. ' +
          'Must contain at least 1 id; all ids must exist in the document.',
        items: { type: 'string' },
      },
      componentId: {
        type: 'string',
        description:
          'Optional explicit component id to assign. When omitted a fresh id is generated via nextId("comp"). ' +
          'Useful for deterministic agent plans that reference the component id immediately after creation.',
      },
    },
    required: ['name', 'entityIds'],
  },
  run: (doc, { name, entityIds, componentId }): CommandResult => {
    // Validate: non-empty list
    if (!Array.isArray(entityIds) || entityIds.length === 0) {
      return {
        document: doc,
        summary: 'create_component: entityIds must be a non-empty array.',
        affected: [],
      };
    }

    // Validate: all ids exist
    const missing = entityIds.filter((id) => !(id in doc.entities));
    if (missing.length > 0) {
      return {
        document: doc,
        summary: `create_component: entity id(s) not found: [${missing.join(', ')}]. Document unchanged.`,
        affected: [],
      };
    }

    // Snapshot the promoted entities as component-local (positions kept as-is;
    // they are already local to the component origin which is at the world origin by default).
    const compEntities: Record<string, Entity> = {};
    const compOrder: string[] = [];
    for (const id of entityIds) {
      const e = doc.entities[id]!;
      compEntities[e.id] = e;
      compOrder.push(e.id);
    }

    const compId = componentId ?? nextId('comp');
    const component: Component = {
      id: compId,
      name,
      entities: compEntities,
      order: compOrder,
    };

    // Remove source entities from doc
    const newEntities = { ...doc.entities };
    for (const id of entityIds) delete newEntities[id];

    const newOrder = doc.order.filter((id) => !entityIds.includes(id));

    // Prune removed ids from groups
    const newGroups = { ...doc.groups };
    for (const [gid, group] of Object.entries(newGroups)) {
      const filtered = group.memberIds.filter((mid) => !entityIds.includes(mid));
      if (filtered.length < 2) {
        // Dissolve groups that would have fewer than 2 members
        delete newGroups[gid];
      } else if (filtered.length !== group.memberIds.length) {
        newGroups[gid] = { ...group, memberIds: filtered };
      }
    }

    // Prune removed ids from selection
    const newSelection = doc.selection.filter((sid) => !entityIds.includes(sid));

    // Insert the replacement instance
    const instanceId = nextId('instance');
    const instance: InstanceEntity = {
      id: instanceId,
      kind: 'instance',
      componentId: compId,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color: '#c8553d',
    };

    return {
      document: {
        ...doc,
        entities: { ...newEntities, [instanceId]: instance },
        order: [...newOrder, instanceId],
        groups: newGroups,
        selection: newSelection,
        components: { ...doc.components, [compId]: component },
      },
      summary: `Created component "${name}" (id: ${compId}) from ${entityIds.length} entit${entityIds.length === 1 ? 'y' : 'ies'} [${entityIds.join(', ')}]; placed instance ${instanceId}.`,
      affected: [instanceId],
    };
  },
};

// ---------------------------------------------------------------------------
// insert_instance
// ---------------------------------------------------------------------------

interface InsertInstanceParams {
  /** Id of an existing Component in doc.components. */
  componentId: string;
  /** World-space placement [x, y, z]. Default: [0, 0, 0]. */
  position?: Vec3;
  /** Euler rotation [rx, ry, rz] in radians. Default: [0, 0, 0]. */
  rotation?: Vec3;
  /** Per-axis scale [sx, sy, sz]. Default: [1, 1, 1]. */
  scale?: Vec3;
}

/**
 * @command insert_instance
 * @pure
 * @layer core/commands
 * @affects [newInstanceId]
 * @invariant componentId must exist in doc.components
 * @invariant position, rotation, scale components must be finite; non-finite values -> no-op
 * @failure unknown componentId -> no-op, affected:[]
 * @failure non-finite transform values -> no-op, affected:[]
 */
export const insertInstance: CommandDefinition<InsertInstanceParams> = {
  name: 'insert_instance',
  description:
    'Place a new InstanceEntity referencing an existing Component definition. ' +
    'The instance carries its own world-space transform (position, rotation, scale). ' +
    'Editing the component later automatically updates all its instances. ' +
    'componentId must exist in doc.components. Returns the new instance id in affected.',
  paramsSchema: {
    type: 'object',
    properties: {
      componentId: {
        type: 'string',
        description: 'Id of an existing Component in doc.components. Obtain via create_component.',
      },
      position: {
        type: 'array',
        description: 'World-space origin [x, y, z] for the instance. Default: [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description: 'Euler rotation [rx, ry, rz] in radians (XYZ order). Default: [0, 0, 0].',
        items: { type: 'number' },
      },
      scale: {
        type: 'array',
        description: 'Per-axis scale factors [sx, sy, sz]. Default: [1, 1, 1]. All components must be finite.',
        items: { type: 'number' },
      },
    },
    required: ['componentId'],
  },
  run: (doc, { componentId, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1] }): CommandResult => {
    const component = doc.components[componentId];
    if (!component) {
      return {
        document: doc,
        summary: `insert_instance: component "${componentId}" not found in doc.components.`,
        affected: [],
      };
    }

    // Validate all transform values are finite
    const allFinite = (...vs: number[]): boolean => vs.every((v) => Number.isFinite(v));
    if (!allFinite(...position) || !allFinite(...rotation) || !allFinite(...scale)) {
      return {
        document: doc,
        summary: `insert_instance: position, rotation, and scale must contain only finite numbers.`,
        affected: [],
      };
    }

    const instanceId = nextId('instance');
    const instance: InstanceEntity = {
      id: instanceId,
      kind: 'instance',
      componentId,
      position,
      rotation,
      scale,
      layerId: DEFAULT_LAYER_ID,
      color: '#c8553d',
    };

    return {
      document: {
        ...doc,
        entities: { ...doc.entities, [instanceId]: instance },
        order: [...doc.order, instanceId],
      },
      summary: `Inserted instance ${instanceId} of component "${component.name}" (${componentId}) at position [${position.join(', ')}].`,
      affected: [instanceId],
    };
  },
};

// ---------------------------------------------------------------------------
// explode_instance
// ---------------------------------------------------------------------------

interface ExplodeInstanceParams {
  /** Id of an InstanceEntity to explode. */
  id: string;
}

/**
 * @command explode_instance
 * @pure
 * @layer core/commands
 * @affects [newEntityIds...] — the fresh concrete entities produced by the bake
 * @invariant instance is replaced in doc.entities/order by its expanded child entities
 * @invariant each produced entity has a fresh id; the component definition is unchanged
 * @failure id is not an instance -> no-op, affected:[]
 * @failure instance's componentId not found in doc.components -> no-op, affected:[]
 */
export const explodeInstance: CommandDefinition<ExplodeInstanceParams> = {
  name: 'explode_instance',
  description:
    'Replace an InstanceEntity with concrete copies of its component\'s entities baked into world space. ' +
    'Each produced entity receives a fresh id. The component definition is NOT removed. ' +
    'The instance entity is removed and its order position is filled with the produced entities. ' +
    'Returns the new entity ids in affected.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Id of an InstanceEntity to explode into its world-space component entities.',
      },
    },
    required: ['id'],
  },
  run: (doc, { id }): CommandResult => {
    const entity = doc.entities[id];
    if (!entity || entity.kind !== 'instance') {
      return {
        document: doc,
        summary: `explode_instance: entity "${id}" is not an instance or does not exist.`,
        affected: [],
      };
    }

    const instance = entity as InstanceEntity;
    const component = doc.components[instance.componentId];
    if (!component) {
      return {
        document: doc,
        summary: `explode_instance: component "${instance.componentId}" referenced by instance "${id}" not found.`,
        affected: [],
      };
    }

    const bakedEntities = expandInstance(instance, component);

    // Remove the instance and insert the baked entities at the same order position
    const instanceOrderIdx = doc.order.indexOf(id);
    const newOrder = [...doc.order];
    const bakedIds = bakedEntities.map((e) => e.id);
    if (instanceOrderIdx >= 0) {
      newOrder.splice(instanceOrderIdx, 1, ...bakedIds);
    } else {
      // Shouldn't happen, but safe fallback
      newOrder.push(...bakedIds);
    }

    const newEntities = { ...doc.entities };
    delete newEntities[id];
    for (const e of bakedEntities) {
      newEntities[e.id] = e;
    }

    // Prune instance from groups
    const newGroups = { ...doc.groups };
    for (const [gid, group] of Object.entries(newGroups)) {
      if (group.memberIds.includes(id)) {
        const filtered = group.memberIds.filter((mid) => mid !== id);
        if (filtered.length < 2) {
          delete newGroups[gid];
        } else {
          newGroups[gid] = { ...group, memberIds: filtered };
        }
      }
    }

    // Prune instance from selection
    const newSelection = doc.selection.filter((sid) => sid !== id);

    return {
      document: {
        ...doc,
        entities: newEntities,
        order: newOrder,
        groups: newGroups,
        selection: newSelection,
      },
      summary: `Exploded instance "${id}" (component "${component.name}", ${instance.componentId}) into ${bakedEntities.length} concrete entit${bakedEntities.length === 1 ? 'y' : 'ies'}: [${bakedIds.join(', ')}].`,
      affected: bakedIds,
    };
  },
};
