/**
 * @layer ui/viewport/3d
 *
 * Shadow-casting key light placement that follows the scene. The original rig was fixed at
 * +-30 units around the origin, so models far larger or farther away (mm-scale buildings) cast no
 * shadows. The rig scales with the scene radius and aims at the scene centre in RENDER space
 * (world - renderOrigin), the space the light lives in.
 */

import type { Bounds } from '@core/commands/sceneTypes';
import type { Vec3 } from '@core/model/types';

/** Half-size of the shadow frustum used for scenes smaller than this (the original fixed rig). */
export const MIN_SHADOW_HALF_EXTENT = 30;
/** Key light offset from its target at the minimum extent (front-right, high angle). */
const BASE_LIGHT_OFFSET: Vec3 = [8, -6, 14];
const BASE_NEAR = 0.5;
const BASE_FAR = 200;
/** Frustum padding over the scene's bounding sphere. */
const PADDING = 1.2;

export interface KeyLightRig {
  readonly target: Vec3;
  readonly position: Vec3;
  /** Orthographic shadow camera half-size (left/right/top/bottom = +-halfExtent). */
  readonly halfExtent: number;
  readonly near: number;
  readonly far: number;
}

/**
 * @pure
 * @invariant bounds null (empty scene) -> the original fixed rig at the origin
 */
export function computeKeyLightRig(bounds: Bounds | null, renderOrigin: Vec3): KeyLightRig {
  const centre: Vec3 = bounds
    ? [
        (bounds.min[0] + bounds.max[0]) / 2 - renderOrigin[0],
        (bounds.min[1] + bounds.max[1]) / 2 - renderOrigin[1],
        (bounds.min[2] + bounds.max[2]) / 2 - renderOrigin[2],
      ]
    : [0, 0, 0];
  const radius = bounds
    ? Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ) / 2
    : 0;
  const halfExtent = Math.max(MIN_SHADOW_HALF_EXTENT, radius * PADDING);
  const scale = halfExtent / MIN_SHADOW_HALF_EXTENT;
  return {
    target: centre,
    position: [
      centre[0] + BASE_LIGHT_OFFSET[0] * scale,
      centre[1] + BASE_LIGHT_OFFSET[1] * scale,
      centre[2] + BASE_LIGHT_OFFSET[2] * scale,
    ],
    halfExtent,
    near: BASE_NEAR * scale,
    far: BASE_FAR * scale,
  };
}
