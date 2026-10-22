/**
 * Curves and features on curved faces (03 WRP): the pcurve a curve on a face keeps
 * (`CurveOnFace`) and the `emboss` recipe node an exact kernel lowers to one `face_slab` per region plus a fuse / cut / split.
 */

import type { NurbsCurve2Data } from '../lib/nurbs/curve2d';
import type { FaceSlabRecipe } from './faceSlab';
import type { Vec2, Vec3 } from './vectors';

export type { NurbsCurve2Data };

/** Where a `nurbs_curve` lies on a face (render depth offset, split, `check_wrap`, regeneration). */
export interface CurveOnFace {
  /** The solid the face belongs to (the entity that existed when the curve was made). */
  readonly entityId: string;
  /** Unique face index at creation. */
  readonly faceIndex: number;
  /** Persistent face name (SC-N1) when the kernel keeps history. */
  readonly faceName?: string;
  /**
   * (u, v) curve: in the face's chart frame (`wrap_to_face`; exact for an affine chart, fitted within `fitTolerance` otherwise), or with `frame: 'native'`
   * in the kernel's own parametrisation of the face (`project_to_face`).
   */
  readonly pcurve: NurbsCurve2Data;
  readonly frame?: 'native';
  /** Fit deviation of the 3D curve from the exact image (document units); 0 when exact. */
  readonly fitTolerance: number;
  /** Length of the curve in the sketch (chart) frame, document units. */
  readonly chartLength: number;
}

/** A closed loop of a region in the surface's (u, v) plane: `start`, then segments, the last ending at `start`. */
export interface UvLoop {
  readonly start: Vec2;
  readonly segments: ReadonlyArray<
    { readonly kind: 'line'; readonly to: Vec2 } | { readonly kind: 'nurbs'; readonly curve: NurbsCurve2Data }
  >;
}

export interface UvRegion {
  readonly outer: UvLoop;
  readonly holes: ReadonlyArray<UvLoop>;
}

/**
 * Parameters of the `emboss` recipe node (`{ op: 'emboss'; source: ShapeRecipe } & EmbossParams`): emboss / deboss / scribe of `regions` on face `face` (unique index of `source` at evaluation). Exact kernels only (capability `emboss`):
 * emboss lifts each region along the face normal from 0 to `depth` and fuses it, deboss cuts from `-depth` to 0, scribe splits the face along
 * the region loops and removes no material.
 * @invariant `surface` is the wire form of `faceSlab` (plane / cylinder / cone) and the loops are in its (u, v); `direction` is the outward
 *   normal at the first loop vertex (the lift sign); `depth` > 0 except scribe (0)
 */
export interface EmbossParams {
  readonly face: number;
  readonly surface: FaceSlabRecipe['surface'];
  readonly regions: ReadonlyArray<UvRegion>;
  readonly mode: 'emboss' | 'deboss' | 'scribe';
  readonly depth: number;
  readonly direction: Vec3;
  /** Sewing / fit tolerance, document units. */
  readonly tolerance: number;
}
