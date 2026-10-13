/**
 * Camera framing of an AABB for the perspective viewport.
 *
 * @layer geometry
 * @pure
 */

import { VIEWPORT_FOV_DEGREES } from '../model/viewport';
import { toRadians } from '../lib/angle';
import { boundsCenter, boundsDiagonalRadius, type Bounds } from './bounds';
import type { Vec3 } from '../model/types';

/** Camera target and eye distance that frame a bounding box. */
export interface Framing {
  readonly center: Vec3;
  readonly distance: number;
}

/** How a (near-)pointlike box is framed. */
export interface FramingOptions {
  /** Bounding-sphere radii below this count as degenerate. Default 0.001. */
  readonly degenerateBelow?: number;
  /** Radius used instead for a degenerate box. Default 1. */
  readonly degenerateRadius?: number;
}

/**
 * Eye distance at which the bounding sphere of `bounds` fits the narrower of the vertical and
 * horizontal half-angles of the viewport camera, times `padding`.
 * @param aspect viewport width / height (default square)
 */
export function fitFraming(bounds: Bounds, aspect = 1, padding = 1.2, options: FramingOptions = {}): Framing {
  const { degenerateBelow = 0.001, degenerateRadius = 1 } = options;
  const extentRadius = boundsDiagonalRadius(bounds);
  const radius = extentRadius > 0 && extentRadius >= degenerateBelow ? extentRadius : degenerateRadius;
  const halfVertical = toRadians(VIEWPORT_FOV_DEGREES / 2);
  const halfAngle = aspect >= 1 ? halfVertical : Math.atan(Math.tan(halfVertical) * Math.max(aspect, 1e-3));
  return { center: boundsCenter(bounds), distance: (radius / Math.sin(halfAngle)) * padding };
}
