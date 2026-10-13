// Instancing batches: entities sharing geometry (kind + params, 6 significant digits), color, layer and material.
// Batchable: box, cylinder, sphere; every other kind renders per entity.

import type { Entity, EntityId, Material } from '@core/model/types';
import { significantNumber } from '@lib/compactNumber';
import type { PbrMaterial } from './useMaterialProps';

type BatchableKind = 'box' | 'cylinder' | 'sphere';

export interface InstanceBatch {
  key: string;
  /** Selects the THREE geometry. */
  kind: BatchableKind;
  /** Sorted by id: the array index is the deterministic instanceId. */
  entities: Entity[];
  /** Base roughness/metalness + shaded instance colors (materialId is part of the key). */
  pbrMaterial?: PbrMaterial;
}

/** e.g. `"box|10|20|30|#c8553d|layer-default"` (+ `|mat:<id>`); null when not batchable. */
export function entityRenderKey(entity: Entity): string | null {
  const { color, layerId } = entity;
  const matSuffix = entity.materialId ? `|mat:${entity.materialId}` : '';
  const n = (v: number): string => significantNumber(v, 6);

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
      return null;
  }
}

export function isBatchable(entity: Entity): boolean {
  return entityRenderKey(entity) !== null;
}

/** Non-batchable entities are omitted (rendered per entity by the caller). */
export function groupEntitiesForInstancing(entities: Entity[], materials: Record<string, Material> = {}): Map<string, InstanceBatch> {
  const map = new Map<string, InstanceBatch>();

  for (const entity of entities) {
    const key = entityRenderKey(entity);
    if (key === null) continue;

    const existing = map.get(key);
    if (existing) {
      existing.entities.push(entity);
    } else {
      const mat = entity.materialId ? materials[entity.materialId] : undefined;
      map.set(key, { key, kind: entity.kind as BatchableKind, entities: [entity], ...(mat && { pbrMaterial: mat }) });
    }
  }

  for (const batch of map.values()) {
    batch.entities.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  return map;
}

export function entityIdFromInstanceId(batch: InstanceBatch, instanceId: number): EntityId | undefined {
  return batch.entities[instanceId]?.id;
}
