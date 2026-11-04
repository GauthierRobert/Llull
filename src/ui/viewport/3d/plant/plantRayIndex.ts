// Instance BVH of the plant scene for picking: `rayQuery` replaces the O(N) scan over every instance of a bucket. The tree comes from
// `plantBvhBuilder` (worker above 10^4 instances, deferred task below); a pick that arrives before it is ready builds it on the spot.

import type { Vec3 } from '@core/model/types';
import type { InstanceBvh } from '@core/geometry/instanceBvh';
import type { PlanScene } from '@core/geometry/renderPlan';
import { plantBvhBuilder } from './plantBvhBuilder';

let lastQuery: { readonly bvh: InstanceBvh; readonly key: string; readonly hits: readonly number[] } | null = null;

/** Scene indices (ascending) of the instances whose AABB the document-space ray touches. One query serves all buckets of the same pick. */
export function rayCandidates(scene: PlanScene, origin: Vec3, direction: Vec3): readonly number[] {
  const bvh = plantBvhBuilder.buildNow(scene);
  const key = `${origin.join(',')}|${direction.join(',')}`;
  if (lastQuery?.bvh === bvh && lastQuery.key === key) return lastQuery.hits;
  const hits = bvh.rayQuery(origin, direction);
  lastQuery = { bvh, key, hits };
  return hits;
}

/** Starts the build of the tree of `scene` off the first pointer move; a newer scene drops the older build. Returns the cancel. */
export function prepareRayIndex(scene: PlanScene): () => void {
  return plantBvhBuilder.request(scene);
}
