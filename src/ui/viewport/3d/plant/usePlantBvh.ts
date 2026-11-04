// The finished instance BVH of a big plant scene (external store: only scenes from WORKER_MIN_INSTANCES can re-render, so small
// documents plan exactly as before). Starts the build; null until it lands.

import { useEffect, useSyncExternalStore } from 'react';
import type { InstanceBvh } from '@core/geometry/instanceBvh';
import type { PlanScene } from '@core/geometry/renderPlan';
import { plantBvhBuilder, WORKER_MIN_INSTANCES } from './plantBvhBuilder';

export function usePlantBvh(scene: PlanScene | null): InstanceBvh | null {
  const big = scene !== null && scene.instances.length >= WORKER_MIN_INSTANCES;
  useEffect(() => (big ? plantBvhBuilder.request(scene) : undefined), [big, scene]);
  const snapshot = (): InstanceBvh | null => (big ? (plantBvhBuilder.ready(scene) ?? null) : null);
  return useSyncExternalStore(plantBvhBuilder.subscribe, snapshot, snapshot);
}
