/**
 * @layer ui/viewport/2d
 *
 * Depth framing for the top-down ortho camera. 2D shapes live on a work plane whose z may be
 * lifted (contours at their elevation, DXF imports keeping elevations). The camera sits a fixed
 * distance above the entity group, so the group is shifted down by the highest plane and the far
 * clip is widened by the plane spread — otherwise lifted shapes fall outside [near, far].
 */

import type { Entity, EntityId } from '@core/model/types';

/** Camera height above the (shifted) topmost plane. */
export const PLAN_CAMERA_HEIGHT = 100;
const PLAN_FAR_MARGIN = 10000;

interface PlanDepth {
  /** Highest entity plane z; the render group is translated by `-top`. */
  readonly top: number;
  /** Lowest entity plane relative to `top` (<= 0): the drafting grid sits just under it. */
  readonly floor: number;
  /** Camera far clip covering every plane from `top` down to the lowest one. */
  readonly far: number;
}

/** @pure */
export function computePlanDepth(
  order: ReadonlyArray<EntityId>,
  entities: Readonly<Record<EntityId, Entity>>,
): PlanDepth {
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
