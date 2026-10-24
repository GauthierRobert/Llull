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
 * - moveFaces (04 DIR M6): `offset` moves each face by `distance` along its surface normal (a plane along its outward normal; a cylinder, cone, sphere
 *   or torus AWAY from its axis / centre, so a bore widens), `translate` / `rotate` move the face set rigidly (one planar face: its new plane, the
 *   neighbours extend; any other set is a feature that is removed and re-created at the new place).
 * - deleteFaces: remove the faces; the neighbouring faces extend to close the gap (a fillet or a hole disappears).
 */
export type FaceOpParams =
  | { readonly kind: 'draft'; readonly faces: readonly number[]; readonly angle: number; readonly pull: Vec3; readonly neutral: PlaneSpec }
  | { readonly kind: 'pushPull'; readonly faces: readonly [number]; readonly distance: number }
  | { readonly kind: 'splitFace'; readonly faces: readonly number[]; readonly plane: PlaneSpec }
  | { readonly kind: 'moveFaces'; readonly faces: readonly number[]; readonly move: FaceMove }
  | { readonly kind: 'deleteFaces'; readonly faces: readonly number[] };

/** How `moveFaces` moves its faces (angles in radians). */
export type FaceMove =
  | { readonly type: 'translate'; readonly vector: Vec3 }
  | { readonly type: 'rotate'; readonly axis: { readonly origin: Vec3; readonly direction: Vec3 }; readonly angle: number }
  | { readonly type: 'offset'; readonly distance: number };
