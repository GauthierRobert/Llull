// Instance BVH of the plant scene for picking: `rayQuery` replaces the O(N) scan over every instance of a bucket. The tree is built once per
// scene object (lazily on the first pick, or earlier by `prepareRayIndex` when the browser is idle) and a newer scene drops the old one.
// The tree is not built in a worker: `InstanceBvh` is a closure over its typed arrays, so it cannot be transferred (09 spec §12.13).

import type { Vec3 } from '@core/model/types';
import { buildInstanceBvh, packBoxes, type InstanceBvh } from '@core/geometry/instanceBvh';
import type { PlanScene } from '@core/geometry/renderPlan';

let current: { readonly scene: PlanScene; readonly bvh: InstanceBvh } | null = null;
let lastQuery: { readonly bvh: InstanceBvh; readonly key: string; readonly hits: readonly number[] } | null = null;
let idleHandle: ReturnType<typeof setTimeout> | undefined;

function bvhOf(scene: PlanScene): InstanceBvh {
  if (current?.scene !== scene) {
    current = { scene, bvh: buildInstanceBvh(packBoxes(scene.instances.map((instance) => instance.aabb))) };
    lastQuery = null;
  }
  return current.bvh;
}

/** Scene indices (ascending) of the instances whose AABB the document-space ray touches. One query serves all buckets of the same pick. */
export function rayCandidates(scene: PlanScene, origin: Vec3, direction: Vec3): readonly number[] {
  const bvh = bvhOf(scene);
  const key = `${origin.join(',')}|${direction.join(',')}`;
  if (lastQuery?.bvh === bvh && lastQuery.key === key) return lastQuery.hits;
  const hits = bvh.rayQuery(origin, direction);
  lastQuery = { bvh, key, hits };
  return hits;
}

/** Builds the tree of `scene` in a later task so the first pointer move does not pay for it; a stale scene is skipped. Returns the cancel. */
export function prepareRayIndex(scene: PlanScene): () => void {
  idleHandle = setTimeout(() => {
    if (current === null || current.scene !== scene) bvhOf(scene);
  }, 50);
  const handle = idleHandle;
  return () => clearTimeout(handle);
}
