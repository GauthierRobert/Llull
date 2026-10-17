/** Depth to the next exit of the material along a hole axis (07 FTR §3.1 `up_to_next`): a centre-line ray cast from the entrance plane. */

import type { Vec2 } from '../model/types';
import type { FeatureFrame } from '../model/features';
import { type MeshBvh, bvhRayCast } from './meshBvh';
import { frameToWorld } from './featureFrame';
import { add3, dot3, scale3, sub3 } from '../lib/vec3';

/**
 * Depth below the entrance plane at which the ray along -normal through `point` first LEAVES the material (the underside of the first wall).
 * @failure the ray meets no surface below the plane, or never leaves the material -> null
 */
export function depthToNextExit(bvh: MeshBvh, frame: FeatureFrame, point: Vec2, maxDistance: number): number | null {
  const start = frameToWorld(frame, point);
  const lift = Math.max(1e-6, maxDistance * 1e-9);
  const down = scale3(frame.normal, -1);
  const above = add3(start, scale3(frame.normal, lift));
  const entry = bvhRayCast(bvh, above, down, maxDistance);
  if (entry === null) return null;
  const exit = bvhRayCast(bvh, add3(entry.point, scale3(down, lift * 1e-3)), down, maxDistance);
  return exit === null ? null : dot3(sub3(start, exit.point), frame.normal);
}
