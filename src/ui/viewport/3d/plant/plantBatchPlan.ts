// Pure glue between the core render plan (R-BATCH-v1) and the viewport: which entities the batch renderer owns, and the draw buckets
// (one InstancedMesh each) of a plan. No three.js, no React.

import type { Entity, EntityId } from '@core/model/types';
import { LEVEL_CULLED, type PlanScene, type RenderPlan } from '@core/geometry/renderPlan';

/** Visible 3D entities from which the plan renderer takes over from the per-entity path (below it the existing renderer is cheaper and exact). */
export const PLANT_BATCH_MIN_INSTANCES = 1500;

/** Kinds whose prototype geometry the LOD cache can build entity-locally (same placement as the per-entity branches). */
const PLANT_KINDS: ReadonlySet<Entity['kind']> = new Set([
  'box',
  'cylinder',
  'cone',
  'sphere',
  'torus',
  'wedge',
  'pyramid',
  'revolution',
  'mesh',
]);

/** True when the plant renderer can draw `entity` (a mesh with per-face colours, or any other kind, stays on the per-entity path). */
export function isPlantBatchable(entity: Entity): boolean {
  if (!PLANT_KINDS.has(entity.kind)) return false;
  return entity.kind !== 'mesh' || entity.faceColors === undefined || entity.faceColors.length === 0;
}

/**
 * Ids of the entities the plant renderer draws: in the plan, a batchable kind, and not claimed by the per-entity path (`needsOwnPath`:
 * animated, finished, transitioning, ghosted, tinted, hidden, exploded...).
 */
export function plantCoveredIds(
  scene: PlanScene,
  entities: Readonly<Record<EntityId, Entity>>,
  needsOwnPath: (entity: Entity) => boolean,
): Set<EntityId> {
  const covered = new Set<EntityId>();
  for (const { id } of scene.instances) {
    const entity = Object.hasOwn(entities, id) ? entities[id] : undefined;
    if (entity !== undefined && isPlantBatchable(entity) && !needsOwnPath(entity)) covered.add(id);
  }
  return covered;
}

export interface DrawBucket {
  /** Stable React key and mesh identity: `prototypeKey|materialClass|lod`. */
  readonly key: string;
  readonly prototypeKey: string;
  readonly materialClass: string;
  readonly lod: 0 | 1 | 2;
  /** Entity id per instance: the index is the `instanceId` of a pick. */
  readonly ids: readonly EntityId[];
  /** Prototype key per instance (a LOD2 box bucket mixes prototypes). */
  readonly prototypes: readonly string[];
}

/**
 * The plan's buckets (plus one LOD0 bucket per unique-geometry instance) as draw buckets restricted to `covered`; empty buckets dropped.
 * With `keepCulled` (camera in motion) the instances the plan culled by size stay as LOD2 boxes (`$culled`), so nothing inside the
 * widened frustum blinks out while orbiting; the settled plan culls them.
 * @invariant order = plan order (buckets sorted by code unit, then unique batches), members ascending, culled boxes last
 */
export function drawBuckets(scene: PlanScene, plan: RenderPlan, covered: ReadonlySet<EntityId>, keepCulled = false): DrawBucket[] {
  const result: DrawBucket[] = [];
  const push = (prototypeKey: string, materialClass: string, lod: 0 | 1 | 2, members: readonly number[]): void => {
    const ids: EntityId[] = [];
    const prototypes: string[] = [];
    for (const index of members) {
      const instance = scene.instances[index];
      if (instance === undefined || !covered.has(instance.id)) continue;
      ids.push(instance.id);
      prototypes.push(scene.prototypeKeys[instance.prototype] ?? '');
    }
    if (ids.length > 0) result.push({ key: `${prototypeKey}|${materialClass}|${lod}`, prototypeKey, materialClass, lod, ids, prototypes });
  };
  for (const bucket of plan.buckets) push(bucket.prototypeKey, bucket.materialClass, bucket.lod, bucket.members);
  for (const batch of plan.uniqueBatches) {
    for (const index of batch.members) {
      const instance = scene.instances[index];
      if (instance !== undefined) push(scene.prototypeKeys[instance.prototype] ?? '', batch.materialClass, 0, [index]);
    }
  }
  if (keepCulled) {
    const byClass = new Map<string, number[]>();
    plan.levels.forEach((level, index) => {
      if (level !== LEVEL_CULLED) return;
      const materialClass = scene.materialClasses[scene.instances[index]?.materialClass ?? 0] ?? '';
      const list = byClass.get(materialClass);
      if (list === undefined) byClass.set(materialClass, [index]);
      else list.push(index);
    });
    for (const [materialClass, members] of byClass) push('$culled', materialClass, 2, members);
  }
  return result;
}

/** Entity id of a pick (`instanceId` of the bucket's InstancedMesh), undefined when out of range. */
export function entityIdAt(bucket: Pick<DrawBucket, 'ids'>, instanceId: number | undefined): EntityId | undefined {
  return instanceId === undefined ? undefined : bucket.ids[instanceId];
}
