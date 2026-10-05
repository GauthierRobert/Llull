/**
 * @layer ui/viewport/3d
 *
 * Pure helpers grouping entities into InstancedMesh batches: entities sharing geometry (kind +
 * params), color, layer and material render as one draw call. Batchable kinds (v1): box, cylinder,
 * sphere; every other kind takes the per-entity mesh path in Entities.tsx.
 *
 * @pure
 */

import type { Entity, EntityId, Material } from '@core/model/types';
import type { PbrMaterial } from './useMaterialProps';

/** Entity kinds that support InstancedMesh rendering in v1. */
type BatchableKind = 'box' | 'cylinder' | 'sphere';

/** A render batch: all entities in the array share the same geometry key. */
export interface InstanceBatch {
  /** The stable render key shared by all entities in this batch. */
  key: string;
  /** Entity kind — determines which THREE geometry to allocate. */
  kind: BatchableKind;
  /**
   * Entities in this batch, sorted by id for deterministic index assignment.
   * The index of an entity in this array is its instanceId in the InstancedMesh.
   */
  entities: Entity[];
  /**
   * Optional PBR material override for this batch. When set, the InstanceBatchMesh uses it for
   * its base roughness/metalness and for instance colors in shaded mode. All entities in a batch
   * share the same materialId (it is part of the key).
   */
  pbrMaterial?: PbrMaterial;
}

/**
 * Stable string key of an entity's geometry + color + layer (+ material), or `null` when its kind
 * is not batchable in v1. Numbers are rounded to 6 significant digits so float noise cannot split
 * a batch.
 *
 * Key shape (box): `"box|10|20|30|#c8553d|layer-default"`; the material, when set, adds
 * `|mat:<id>` so entities with different materials never share a batch.
 *
 * @pure
 */
export function entityRenderKey(entity: Entity): string | null {
  const { color, layerId } = entity;
  const matSuffix = entity.materialId ? `|mat:${entity.materialId}` : '';
  const n = (v: number): string => parseFloat(v.toPrecision(6)).toString();

  switch (entity.kind) {
    case 'box': {
      const [w, h, d] = entity.size;
      return `box|${n(w)}|${n(h)}|${n(d)}|${color}|${layerId}${matSuffix}`;
    }
    case 'cylinder':
      return `cylinder|${n(entity.radius)}|${n(entity.height)}|${color}|${layerId}${matSuffix}`;
    case 'sphere':
      return `sphere|${n(entity.radius)}|${color}|${layerId}${matSuffix}`;
    default:
      // Not batchable in v1.
      return null;
  }
}

/** Returns true when the entity kind is batchable in v1. */
export function isBatchable(entity: Entity): boolean {
  return entityRenderKey(entity) !== null;
}

/**
 * Groups visible entities into InstancedMesh batches, keyed by `entityRenderKey`. Non-batchable
 * entities are omitted (the caller renders them per entity). Entities within a batch are sorted by
 * id so the instanceId → entityId mapping is deterministic across renders; `materials` resolves
 * each batch's PBR override.
 *
 * @pure
 */
export function groupEntitiesForInstancing(
  entities: Entity[],
  materials: Record<string, Material> = {},
): Map<string, InstanceBatch> {
  const map = new Map<string, InstanceBatch>();

  for (const entity of entities) {
    const key = entityRenderKey(entity);
    if (key === null) continue; // non-batchable — skip

    const existing = map.get(key);
    if (existing) {
      existing.entities.push(entity);
    } else {
      // All entities of a batch share the same materialId (it is part of the key).
      const mat = entity.materialId ? materials[entity.materialId] : undefined;
      map.set(key, {
        key,
        kind: entity.kind as BatchableKind,
        entities: [entity],
        ...(mat && { pbrMaterial: mat }),
      });
    }
  }

  // Sort each batch by entity id for deterministic instanceId ordering.
  for (const batch of map.values()) {
    batch.entities.sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  }

  return map;
}

/**
 * Given a batch and an instanceId (from InstancedMesh.raycast), returns the
 * entity id at that index, or `undefined` if the index is out of range.
 *
 * @pure
 */
export function entityIdFromInstanceId(
  batch: InstanceBatch,
  instanceId: number,
): EntityId | undefined {
  return batch.entities[instanceId]?.id;
}
