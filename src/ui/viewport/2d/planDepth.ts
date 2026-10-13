// Top-down depth framing: lifted work planes (contours, DXF elevations) would leave [near, far], so the group shifts
// down by the highest plane and the far clip widens by the plane spread.

import type { Entity, EntityId } from '@core/model/types';

/** Above the (shifted) topmost plane. */
export const PLAN_CAMERA_HEIGHT = 100;
const PLAN_FAR_MARGIN = 10000;

interface PlanDepth {
  /** Highest plane z; the group is translated by `-top`. */
  readonly top: number;
  /** Lowest plane relative to `top` (<= 0); the grid sits just under it. */
  readonly floor: number;
  /** Covers every plane. */
  readonly far: number;
}

export function computePlanDepth(order: ReadonlyArray<EntityId>, entities: Readonly<Record<EntityId, Entity>>): PlanDepth {
  let top = 0;
  let bottom = 0;
  for (const id of order) {
    const z = entities[id]?.position[2];
    if (z === undefined || !Number.isFinite(z)) continue;
    if (z > top) top = z;
    if (z < bottom) bottom = z;
  }
  return { top, floor: bottom - top, far: PLAN_CAMERA_HEIGHT + (top - bottom) + PLAN_FAR_MARGIN };
}
