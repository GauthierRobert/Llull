/**
 * @layer ui/viewport/3d
 *
 * Pure helpers for grouping entities into InstancedMesh batches.
 *
 * A "batch" is a set of entities that share the same geometry (kind + geometric
 * params) and base color. They can be rendered as a single InstancedMesh draw call.
 *
 * Supported (batchable) kinds in v1: box, cylinder, sphere.
 * Non-batchable: extrusion, mesh, cone, torus, wedge, pyramid (and all 2D kinds).
 * Non-batchable entities fall through to the per-entity mesh path in Entities.tsx.
 *
 * @pure — all exports are pure functions; no React, no DOM, no side effects.
 */

import type { Entity, EntityId, Material } from '@core/model/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Entity kinds that support InstancedMesh rendering in v1. */
export type BatchableKind = 'box' | 'cylinder' | 'sphere';

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
   * Optional PBR material override for this batch (VNF4).
   * When set, the InstanceBatchMesh uses these values for its base
   * roughness/metalness, and for instance colors in shaded mode.
   * All entities in a batch share the same materialId (it is part of the key).
   */
  pbrMaterial?: {
    /** Diffuse/albedo color (hex). Used as default instance color in shaded mode. */
    color: string;
    /** PBR metalness in [0,1]. Applied to the shared MeshStandardMaterial. */
    metalness: number;
    /** PBR roughness in [0,1]. Applied to the shared MeshStandardMaterial. */
    roughness: number;
  };
}

// ---------------------------------------------------------------------------
// Geometry key extraction (pure)
// ---------------------------------------------------------------------------

/**
 * Returns a stable string key encoding the geometry + color + layer of an
 * entity, or `null` if the entity kind is not batchable in v1.
 *
 * Key shape:  `"<kind>|<geo-params>|<color>|<layerId>"`
 *   box:      `"box|10|20|30|#c8553d|layer-default"`
 *   cylinder: `"cylinder|5|12|#abc123|layer-default"`
 *   sphere:   `"sphere|7|#ff0000|layer-default"`
 *
 * Precision: numbers are rounded to 6 significant digits to avoid float noise
 * creating spurious batch splits for values that differ only by epsilon.
 *
 * @pure
 */
export function entityRenderKey(entity: Entity): string | null {
  const { color, layerId } = entity;
  // materialId is part of the key so entities with different materials form separate
  // batches — this ensures per-material PBR values can be applied at the batch level.
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

// ---------------------------------------------------------------------------
// Grouping (pure)
// ---------------------------------------------------------------------------

/**
 * Groups a flat array of visible entities into InstancedMesh batches.
 *
 * - Non-batchable entities are omitted (the caller renders them per-entity).
 * - Batches with a single entity are still returned as batches (the renderer
 *   can choose to fall through or not — having 1-instance InstancedMesh is
 *   valid, just not optimal). In practice Entities.tsx checks `isBatchable` to
 *   skip per-entity rendering for any entity claimed here.
 * - Entities within each batch are sorted by id (ascending, lexicographic)
 *   so that instanceId → entityId mapping is deterministic across re-renders.
 * - `materials` is used to resolve per-batch PBR overrides (VNF4). Entities
 *   with different materialIds have different batch keys so they never merge.
 *
 * @pure — no mutation, no side effects.
 * @param entities — flat array of entities to group (already filtered for visibility by the caller).
 * @param materials — document material library; used to set `pbrMaterial` on each batch.
 * @returns Map from render key → InstanceBatch.
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
      // Resolve PBR material for this batch (all entities share the same materialId).
      const mat = entity.materialId ? materials[entity.materialId] : undefined;

      if (mat) {
        map.set(key, {
          key,
          kind: entity.kind as BatchableKind,
          entities: [entity],
          pbrMaterial: { color: mat.color, metalness: mat.metalness, roughness: mat.roughness },
        });
      } else {
        map.set(key, {
          key,
          kind: entity.kind as BatchableKind,
          entities: [entity],
        });
      }
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

// ---------------------------------------------------------------------------
// Instance index lookup (pure)
// ---------------------------------------------------------------------------

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
