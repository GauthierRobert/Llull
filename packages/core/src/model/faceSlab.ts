import type { Vec3 } from './vectors';

/**
 * The `faceSlab` node of a `ShapeRecipe` (06 CMP ply solids): the face of `surface` bounded by `loops` (the (u, v) polygons of `encodeLoops`), lifted along
 * its normal from offset `from` to `to` (> from). `direction` is the lift direction at the first loop vertex (it fixes the sign of the normal),
 * `tolerance` the sewing tolerance. Only an exact kernel with the capability `faceSlab` builds it.
 * `surface.data` is the number list of `geometry/surfaceWire` (bspline) or: plane = origin, xDir, yDir; cylinder = origin, axis, xDir, radius
 * (u = azimuth from xDir, v = axial); cone = apex, axis, xDir, semi-angle (u = azimuth, v = distance from the apex).
 */
export interface FaceSlabRecipe {
  readonly op: 'faceSlab';
  readonly surface: { readonly type: 'bspline' | 'plane' | 'cylinder' | 'cone'; readonly data: readonly number[] };
  readonly loops: readonly number[];
  readonly from: number;
  readonly to: number;
  readonly direction: Vec3;
  readonly tolerance: number;
}
