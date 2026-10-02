/**
 * 2D modify commands — edit existing 2D shapes (pure, no mutation).
 *
 * Offset convention (offset_2d):
 *   Positive distance offsets to the LEFT of the direction of travel (start→end for
 *   a line; point[i]→point[i+1] for each polyline segment). Negative is to the right.
 *   For a circle, positive distance creates a larger concentric circle; negative a smaller one.
 *   For a rectangle, positive expands all four sides outward.
 *
 * Trim convention (trim):
 *   The endpoint of `id` that is CLOSER to the intersection point is moved to that
 *   intersection (i.e. the shorter side is "trimmed off"; the longer side is kept).
 *
 * Extend convention (extend):
 *   The endpoint of `id` that is CLOSER to the boundary line (projected) is extended
 *   to meet the boundary.
 *
 * Fillet/Chamfer corner selection (fillet_2d / chamfer_2d):
 *   Single-corner mode: specify `vertexIndex` (0-based). The arc or bevel is inserted
 *   between the two segments meeting at that vertex.
 *
 * @layer core/commands
 */

export {
  cross2,
  dot2,
  len2,
  normalize2,
  perp2,
  segIntersect,
  evalLine,
  offsetSegment,
  miterJoin,
} from './modify2dGeometry';
export { explodePolyline, offset2D } from './modify2dBasic';
export { trim, extend } from './modify2dTrimExtend';
export { fillet2D, chamfer2D } from './modify2dCorners';
