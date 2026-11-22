// Instance entities of one component drawn as InstancedMeshes (TR-ASC-06): one batch per (component, child solid), so a pattern of N
// instances of an M-solid component costs M draw calls. Pure: the renderer maps `instanceId` -> `ids[instanceId]`.

import { type CadDocument, type Component, type Entity, type EntityId, type InstanceEntity, is3D } from '@core/model/types';

/** Fewer instances of a component keep the per-entity path (own materials, decals, animation hooks). */
export const MIN_INSTANCES_PER_COMPONENT = 8;

export interface ComponentBatch {
  /** `<componentId>|<childId>`: stable identity of the geometry. */
  key: string;
  child: Entity;
  /** Instance entity ids sorted by id: the array index is the deterministic `instanceId`. */
  ids: EntityId[];
}

export interface ComponentBatchPlan {
  batches: ComponentBatch[];
  /** Instance ids drawn by a batch (the per-entity path skips them). */
  covered: ReadonlySet<EntityId>;
}

export const NO_COMPONENT_BATCHES: ComponentBatchPlan = { batches: [], covered: new Set() };

/** A component qualifies when every child is a plain 3D solid (no decals, no nested instance, no 2D shape). */
function isPlainSolidComponent(component: Component): boolean {
  const children = component.order.map((id) => component.entities[id]).filter((child): child is Entity => child !== undefined);
  return children.length > 0 && children.every((child) => is3D(child) && child.kind !== 'instance' && child.decals === undefined);
}

/** A mirroring scale flips winding; `InstancedMesh` does not correct that per instance, so such instances stay per entity. */
function isMirrored(instance: InstanceEntity): boolean {
  const [sx, sy, sz] = instance.scale ?? [1, 1, 1];
  return sx * sy * sz <= 0;
}

/** `eligible` filters instances that need the per-entity path (animated, finished, transitioning, ghosted). */
export function planComponentBatches(
  instances: readonly Entity[],
  components: CadDocument['components'],
  eligible: (instance: InstanceEntity) => boolean,
  minInstances: number = MIN_INSTANCES_PER_COMPONENT,
): ComponentBatchPlan {
  const byComponent = new Map<string, InstanceEntity[]>();
  for (const entity of instances) {
    if (entity.kind !== 'instance' || isMirrored(entity) || !eligible(entity)) continue;
    const list = byComponent.get(entity.componentId);
    if (list) list.push(entity);
    else byComponent.set(entity.componentId, [entity]);
  }

  const batches: ComponentBatch[] = [];
  const covered = new Set<EntityId>();
  for (const [componentId, members] of byComponent) {
    const component = components[componentId];
    if (component === undefined || members.length < minInstances || !isPlainSolidComponent(component)) continue;
    const ids = members.map((member) => member.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const childId of component.order) {
      const child = component.entities[childId];
      if (child !== undefined) batches.push({ key: `${componentId}|${childId}`, child, ids });
    }
    for (const id of ids) covered.add(id);
  }
  return batches.length === 0 ? NO_COMPONENT_BATCHES : { batches, covered };
}
