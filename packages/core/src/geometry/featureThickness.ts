/** Local material thickness at a hole (07 FTR §5.3): a ray cast along the hole axis, just outside the widest part of the hole. */

import type { Vec3 } from '../model/types';
import { type MeshBvh, bvhRayCast } from './meshBvh';
import { frameYDir } from './featureFrame';
import type { MachinedHole } from './featureInstances';
import { add3, dot3, scale3, sub3 } from '../lib/vec3';

/** Gap between the widest hole radius and the cast line, as a fraction of that radius. */
const LATERAL_MARGIN = 0.05;

/**
 * Thickness of the material the hole passes through, measured from the entrance plane to the first exit on a line parallel to the hole axis
 * at the hole's widest radius + 5%. Tries +u, -u, +v, -v until one line meets the part.
 * @failure no cast line meets the part -> null
 */
export function localThickness(bvh: MeshBvh, hole: MachinedHole, maxDistance: number): number | null {
  const widest = Math.max(hole.diameter, hole.cboreDiameter ?? 0, hole.cskDiameter ?? 0) / 2;
  const offset = widest * (1 + LATERAL_MARGIN) + 1e-9;
  const lift = Math.max(1e-6, widest * 1e-3);
  const down: Vec3 = scale3(hole.frame.normal, -1);
  const yDir = frameYDir(hole.frame);
  for (const lateral of [hole.frame.xDir, scale3(hole.frame.xDir, -1), yDir, scale3(yDir, -1)]) {
    const start = add3(add3(hole.position, scale3(lateral, offset)), scale3(hole.frame.normal, lift));
    const entry = bvhRayCast(bvh, start, down, maxDistance);
    if (entry === null) continue;
    const exit = bvhRayCast(bvh, add3(entry.point, scale3(down, lift * 1e-3)), down, maxDistance);
    if (exit !== null) return dot3(sub3(entry.point, exit.point), hole.frame.normal);
  }
  return null;
}
