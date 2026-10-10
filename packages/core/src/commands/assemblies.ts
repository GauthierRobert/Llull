/**
 * Assembly commands: create_component, insert_instance, explode_instance.
 * Instances reference a component by id; `expandInstance` (./instanceExpansion) bakes one into
 * world-space entities.
 *
 * @layer core/commands
 */

import type { Component, Entity, InstanceEntity, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, vec3, z } from './schema';
import { DEFAULT_LAYER_ID } from '../model/types';
import { UNIT_SCALE, expandInstance } from './instanceExpansion';
import { nextId } from '../lib/id';
import { commitEntity } from './commitEntity';
import {
  referenceLossSuffix,
  referenceSuffix,
  replaceEntities,
  withoutEntities,
} from './entityOps';
import { changed, noop } from './noop';
import { EXTRUSION_COLOR } from './geometryShared';
import { ORIGIN } from '../lib/vec3';

/** A fresh instance of `componentId` (default color `#c8553d`). */
export function instanceEntity(
  id: string,
  componentId: string,
  position: Vec3,
  rotation: Vec3,
  scale?: Vec3,
): InstanceEntity {
  return {
    id,
    kind: 'instance',
    componentId,
    position,
    rotation,
    ...(scale ? { scale } : {}),
    layerId: DEFAULT_LAYER_ID,
    color: EXTRUSION_COLOR,
  };
}

/**
 * A component reference cycle reachable from `startId` (e.g. `['A', 'B', 'A']`: A contains an
 * instance of B which contains an instance of A), or null when the component graph is acyclic.
 * Missing components are ignored. @pure
 */
export function findComponentCycle(
  components: Readonly<Record<string, Component>>,
  startId: string,
): string[] | null {
  const visit = (id: string, path: string[]): string[] | null => {
    const component = Object.hasOwn(components, id) ? components[id] : undefined;
    if (!component) return null;
    for (const child of Object.values(component.entities)) {
      if (child.kind !== 'instance') continue;
      if (child.componentId === startId) return [...path, id, startId];
      if (path.includes(child.componentId) || child.componentId === id) continue;
      const found = visit(child.componentId, [...path, id]);
      if (found) return found;
    }
    return null;
  };
  return visit(startId, []);
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
export const createComponent = defineCommand({
  name: 'create_component',
  description:
    'Promote a set of existing entities into a reusable Component definition. ' +
    'The source entities are removed from the document and replaced by a single InstanceEntity ' +
    'at position [0,0,0] referencing the new component. ' +
    'All ids in entityIds must exist in the document; any missing id causes a graceful no-op. ' +
    'Returns the new instance id in affected.',
  params: z.object({
    name: z
      .string()
      .describe(
        'Human-readable name for the component, e.g. "Wheel". Used as the component label.',
      ),
    entityIds: z
      .array(z.string())
      .describe(
        'Ids of existing document entities to collect into the component. ' +
          'Must contain at least 1 id; all ids must exist in the document.',
      ),
    componentId: z
      .string()
      .optional()
      .describe(
        'Optional explicit component id to assign. When omitted a fresh id is generated via nextId("comp"). ' +
          'Useful for deterministic agent plans that reference the component id immediately after creation. ' +
          'An id that already names a component is refused unless replace is true.',
      ),
    replace: z
      .boolean()
      .optional()
      .describe(
        'Set true to overwrite the existing component named by componentId (every instance of it then ' +
          'shows the new definition). Default false: reusing an existing component id is refused.',
      ),
  }),
  run: (doc, { name, entityIds, componentId, replace = false }): CommandResult => {
    if (entityIds.length === 0)
      return noop(doc, 'create_component: entityIds must be a non-empty array.');

    const missing = entityIds.filter((id) => !(id in doc.entities));
    if (missing.length > 0) {
      return noop(
        doc,
        `create_component: entity id(s) not found: [${missing.join(', ')}]. Document unchanged.`,
      );
    }

    const compId = componentId ?? nextId('comp');
    if (!replace && Object.hasOwn(doc.components, compId)) {
      return noop(
        doc,
        `create_component: component "${compId}" already exists; choose another componentId, or pass replace:true to overwrite it (its instances would then show the new definition). Document unchanged.`,
      );
    }
    const component: Component = {
      id: compId,
      name,
      entities: Object.fromEntries(entityIds.map((id) => [id, doc.entities[id] as Entity])),
      order: [...entityIds],
    };
    const cycle = findComponentCycle({ ...doc.components, [compId]: component }, compId);
    if (cycle) {
      return noop(
        doc,
        `create_component: component "${compId}" would contain itself (${cycle.join(' -> ')}); ` +
          'a component cannot (indirectly) hold an instance of itself. Document unchanged.',
      );
    }
    const instanceId = nextId('instance');
    const instance = instanceEntity(instanceId, compId, ORIGIN, ORIGIN);
    const replaced = replaceEntities(doc, entityIds, instance);

    return changed(
      { ...replaced, components: { ...doc.components, [compId]: component } },
      `Created component "${name}" (id: ${compId}) from ${entityIds.length} entit${entityIds.length === 1 ? 'y' : 'ies'} [${entityIds.join(', ')}]; placed instance ${instanceId}.${referenceLossSuffix(doc, replaced)}`,
      [instanceId],
    );
  },
});

/**
 * @command insert_instance
 * @pure
 * @layer core/commands
 * @affects [newInstanceId]
 * @invariant componentId must exist in doc.components
 * @failure unknown componentId -> no-op, affected:[]
 */
export const insertInstance = defineCommand({
  name: 'insert_instance',
  description:
    'Place a new InstanceEntity referencing an existing Component definition. ' +
    'The instance carries its own world-space transform (position, rotation, scale). ' +
    'Editing the component later automatically updates all its instances. ' +
    'componentId must exist in doc.components. Returns the new instance id in affected.',
  params: z.object({
    componentId: z
      .string()
      .describe('Id of an existing Component in doc.components. Obtain via create_component.'),
    position: vec3('World-space origin [x, y, z] for the instance. Default: [0, 0, 0].').optional(),
    rotation: vec3(
      'Euler rotation [rx, ry, rz] in radians (XYZ order). Default: [0, 0, 0].',
    ).optional(),
    scale: vec3(
      'Per-axis scale factors [sx, sy, sz]. Default: [1, 1, 1]. All components must be finite.',
    ).optional(),
  }),
  run: (
    doc,
    { componentId, position: rawPosition, rotation: rawRotation, scale },
  ): CommandResult => {
    const position = rawPosition ?? ORIGIN;
    const rotation = rawRotation ?? ORIGIN;
    const component = doc.components[componentId];
    if (!component)
      return noop(doc, `insert_instance: component "${componentId}" not found in doc.components.`);

    const instanceId = nextId('instance');
    const instance = instanceEntity(
      instanceId,
      componentId,
      position,
      rotation,
      scale ?? UNIT_SCALE,
    );

    return commitEntity(
      doc,
      instance,
      `Inserted instance ${instanceId} of component "${component.name}" (${componentId}) at position [${position.join(', ')}].`,
    );
  },
});

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
export const explodeInstance = defineCommand({
  name: 'explode_instance',
  description:
    "Replace an InstanceEntity with concrete copies of its component's entities baked into world space. " +
    'Each produced entity receives a fresh id. The component definition is NOT removed. ' +
    'The instance entity is removed and its order position is filled with the produced entities. ' +
    'Returns the new entity ids in affected.',
  params: z.object({
    id: z
      .string()
      .describe('Id of an InstanceEntity to explode into its world-space component entities.'),
  }),
  run: (doc, { id }): CommandResult => {
    const entity = doc.entities[id];
    if (!entity || entity.kind !== 'instance')
      return noop(doc, `explode_instance: entity "${id}" is not an instance or does not exist.`);

    const component = doc.components[entity.componentId];
    if (!component) {
      return noop(
        doc,
        `explode_instance: component "${entity.componentId}" referenced by instance "${id}" not found.`,
      );
    }

    const bakedEntities = expandInstance(entity, component);

    const bakedIds = bakedEntities.map((e) => e.id);
    const { document: rest, prunedReferences } = withoutEntities(doc, new Set([id]));
    const document = {
      ...rest,
      entities: { ...rest.entities, ...Object.fromEntries(bakedEntities.map((e) => [e.id, e])) },
      order: doc.order.flatMap((orderId) => (orderId === id ? bakedIds : [orderId])),
    };

    return changed(
      document,
      `Exploded instance "${id}" (component "${component.name}", ${entity.componentId}) into ${bakedEntities.length} concrete entit${bakedEntities.length === 1 ? 'y' : 'ies'}: [${bakedIds.join(', ')}].${referenceSuffix(prunedReferences)}`,
      bakedIds,
    );
  },
});
