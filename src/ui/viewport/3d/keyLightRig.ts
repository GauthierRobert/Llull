// Shadow key light following the scene: its shadow frustum hugs the scene's bounding sphere (a fixed ±30 rig left mm-scale buildings
// unshadowed, and spent a 2048² map on 60 units around a 2-unit part: its shadow was a few texels wide and PCSS blurred it away),
// aimed at the scene's centre in RENDER space.

import { type Bounds, boundsCenter, boundsDiagonalRadius } from '@core/geometry/bounds';
import type { Vec3 } from '@core/model/types';
import { toRenderPosition } from './floatingOrigin';

/** Frustum half-size of the empty scene, and the size the light offset / depth range are given for. */
export const BASE_SHADOW_HALF_EXTENT = 30;
/** A point-like scene never yields a zero-size frustum. */
const MIN_HALF_EXTENT = 1e-3;
/**
 * Front-left of the default (iso) view, ~55 degrees high, at the base extent. The camera looks from +X -Y: a light on the camera's own
 * side throws every shadow behind the part, out of sight; from the left they fall across the ground to the right, where they read.
 */
const BASE_LIGHT_OFFSET: Vec3 = [-4, -9, 14];
const BASE_LIGHT_DISTANCE = Math.hypot(...BASE_LIGHT_OFFSET);
const BASE_NEAR = 0.5;
const BASE_FAR = 200;
/** Over the bounding sphere: room for the shadows the scene casts on the ground beside itself (the light is ~50 degrees high). */
const PADDING = 2.2;

export interface KeyLightRig {
  readonly target: Vec3;
  readonly position: Vec3;
  /** Ortho shadow camera ±halfExtent. */
  readonly halfExtent: number;
  readonly near: number;
  readonly far: number;
}

/** @invariant sunDirection (unit, toward the sun) replaces the default light direction, keeping its distance
 * @invariant bounds null (empty scene) -> the base rig at the origin; else halfExtent = bounding-sphere radius × PADDING */
export function computeKeyLightRig(bounds: Bounds | null, renderOrigin: Vec3, sunDirection?: Vec3): KeyLightRig {
  const centre: Vec3 = bounds ? toRenderPosition(boundsCenter(bounds), renderOrigin) : [0, 0, 0];
  const halfExtent = bounds ? Math.max(boundsDiagonalRadius(bounds) * PADDING, MIN_HALF_EXTENT) : BASE_SHADOW_HALF_EXTENT;
  const scale = halfExtent / BASE_SHADOW_HALF_EXTENT;
  // Site-context sun: same distance as the default light, along the computed direction.
  const offset: Vec3 =
    sunDirection === undefined
      ? BASE_LIGHT_OFFSET
      : [sunDirection[0] * BASE_LIGHT_DISTANCE, sunDirection[1] * BASE_LIGHT_DISTANCE, sunDirection[2] * BASE_LIGHT_DISTANCE];
  return {
    target: centre,
    position: [centre[0] + offset[0] * scale, centre[1] + offset[1] * scale, centre[2] + offset[2] * scale],
    halfExtent,
    near: BASE_NEAR * scale,
    far: BASE_FAR * scale,
  };
}
