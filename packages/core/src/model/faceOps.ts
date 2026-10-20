/** Face operations on an exact B-rep (SC-F1): the parameters of a `{ op: 'faceOp' }` recipe node. */

import type { Vec3 } from './vectors';

/** A plane by a point on it and its unit normal. */
export interface PlaneSpec {
  readonly origin: Vec3;
  readonly normal: Vec3;
}

/**
 * `faces` index the unique faces of the node's `source` (`ShapeTopology.faces`).
 * - draft: tilt each face by `angle` radians about its intersection with the `neutral` plane, so it opens along `pull` (mould release).
 * - pushPull: move one planar face along its outward normal by `distance` (> 0 adds material, < 0 removes it), sides follow.
 * - splitFace: cut each face along its intersection with `plane` (the body stays one solid, the faces become two each).
 */
export type FaceOpParams =
  | { readonly kind: 'draft'; readonly faces: readonly number[]; readonly angle: number; readonly pull: Vec3; readonly neutral: PlaneSpec }
  | { readonly kind: 'pushPull'; readonly faces: readonly [number]; readonly distance: number }
  | { readonly kind: 'splitFace'; readonly faces: readonly number[]; readonly plane: PlaneSpec };

export type FaceOpKind = FaceOpParams['kind'];
