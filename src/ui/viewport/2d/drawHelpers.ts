/**
 * @layer ui/viewport/2d
 *
 * Pure geometry helpers for the interactive 2D draw tools.
 *
 * All functions are deterministic and side-effect free — they compute
 * dispatch params from raw click coordinates. Unit-tested in tests/unit/.
 *
 * @pure
 */

import type { Vec2, Vec3 } from '@core/model/types';

// ---------------------------------------------------------------------------
// Rectangle from two corners
// ---------------------------------------------------------------------------

export interface RectParams {
  width: number;
  height: number;
  position: Vec3;
}

/**
 * Compute draw_rectangle params from two arbitrary corner clicks.
 *
 * The lower-left corner becomes the work-plane origin (position).
 * Width is always positive (|x2-x1|), height always positive (|y2-y1|).
 *
 * @pure
 * @failure returns null when the two corners are identical (zero area)
 */
export function rectParamsFromCorners(a: Vec2, b: Vec2): RectParams | null {
  const minX = Math.min(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const width = Math.abs(b[0] - a[0]);
  const height = Math.abs(b[1] - a[1]);

  if (width === 0 || height === 0) return null;

  return {
    width,
    height,
    position: [minX, minY, 0],
  };
}

// ---------------------------------------------------------------------------
// Circle from two points
// ---------------------------------------------------------------------------

/**
 * Compute the radius for draw_circle from a center point and a rim point.
 *
 * @pure
 * @failure returns null when center and rim are identical (radius = 0)
 */
export function circleRadiusFromPoints(center: Vec2, rim: Vec2): number | null {
  const dx = rim[0] - center[0];
  const dy = rim[1] - center[1];
  const r = Math.sqrt(dx * dx + dy * dy);
  return r > 0 ? r : null;
}

// ---------------------------------------------------------------------------
// Ellipse from center + corner
// ---------------------------------------------------------------------------

export interface EllipseParams {
  center: Vec2;
  radiusX: number;
  radiusY: number;
}

/**
 * Compute draw_ellipse params from a center click and a "corner" click.
 *
 * The corner defines the bounding box half-extents: radiusX = |dx|, radiusY = |dy|.
 * Both axes must be non-zero (the two clicks must differ on both axes).
 *
 * @pure
 * @failure returns null when the corner is collinear with the center on either axis
 */
export function ellipseParamsFromCenterCorner(center: Vec2, corner: Vec2): EllipseParams | null {
  const radiusX = Math.abs(corner[0] - center[0]);
  const radiusY = Math.abs(corner[1] - center[1]);
  if (radiusX === 0 || radiusY === 0) return null;
  return { center, radiusX, radiusY };
}

// ---------------------------------------------------------------------------
// Spline point collection helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a candidate spline point list meets the minimum length for dispatch.
 * Returns the list unchanged when valid, null when too short.
 *
 * @pure
 * @failure returns null when fewer than 2 points are provided
 */
export function validateSplinePoints(points: ReadonlyArray<Vec2>): ReadonlyArray<Vec2> | null {
  return points.length >= 2 ? points : null;
}
