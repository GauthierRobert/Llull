// Shadow key light following the scene: scales with its radius (a fixed ±30 rig left mm-scale buildings unshadowed) and
// aims at its centre in RENDER space.

import { type Bounds, boundsCenter, boundsDiagonalRadius } from '@core/geometry/bounds';
import type { Vec3 } from '@core/model/types';
import { toRenderPosition } from './floatingOrigin';

/** Frustum half-size floor (the original fixed rig). */
export const MIN_SHADOW_HALF_EXTENT = 30;
/** Front-right, high angle, at the minimum extent. */
const BASE_LIGHT_OFFSET: Vec3 = [8, -6, 14];
const BASE_NEAR = 0.5;
const BASE_FAR = 200;
/** Over the bounding sphere. */
const PADDING = 1.2;

export interface KeyLightRig {
  readonly target: Vec3;
  readonly position: Vec3;
  /** Ortho shadow camera ±halfExtent. */
  readonly halfExtent: number;
  readonly near: number;
  readonly far: number;
}

/** @invariant bounds null (empty scene) -> the original fixed rig at the origin */
export function computeKeyLightRig(bounds: Bounds | null, renderOrigin: Vec3): KeyLightRig {
  const centre: Vec3 = bounds ? toRenderPosition(boundsCenter(bounds), renderOrigin) : [0, 0, 0];
  const radius = bounds ? boundsDiagonalRadius(bounds) : 0;
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
