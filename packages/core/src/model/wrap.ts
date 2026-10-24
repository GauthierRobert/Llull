/**
 * Curves and features on curved faces (03 WRP): the pcurve a curve on a face keeps
 * (`CurveOnFace`) and the `emboss` recipe node an exact kernel lowers to one `face_slab` per region plus a fuse / cut / split.
 */

import type { NurbsCurve2Data } from '../lib/nurbs/curve2d';
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

/**
 * Wire form of the surface an emboss lifts from: plane = origin, xDir, yDir; cylinder = origin, axis, xDir, radius; cone = apex, axis, xDir, semi-angle;
 * sphere = centre, polar axis, xDir, radius (u = azimuth from xDir, v = latitude); torus = centre, axis, xDir, major radius, minor radius (u = azimuth about
 * the axis, v = angle round the tube, 0 on the outer equator); face = the surface of face `face` of the source itself, in the kernel's own (u, v) (split only, any face kind,
 * `data` empty). (u, v) of the loops are the parameters of that frame.
 */
export interface EmbossSurface {
  readonly type: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'face';
  readonly data: readonly number[];
}

/** A loop of a region in the surface's (u, v) plane (closed: the last segment ends at `start`), or an open chain of a split. */
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
 * the region loops and removes no material, split divides the face along the open or closed `chains` (no regions) and removes no material.
 * @invariant `surface` is an `EmbossSurface` and the loops are in its (u, v); `direction` is the outward
 *   normal at the first loop vertex (the lift sign); `depth` > 0 except scribe (0)
 */
export interface EmbossParams {
  readonly face: number;
  readonly surface: EmbossSurface;
  readonly regions: ReadonlyArray<UvRegion>;
  /** Split only: the curves (in (u, v)) the face is divided along; absent otherwise. */
  readonly chains?: ReadonlyArray<UvLoop>;
  readonly mode: 'emboss' | 'deboss' | 'scribe' | 'split';
  readonly depth: number;
  readonly direction: Vec3;
  /** Sewing / fit tolerance, document units. */
  readonly tolerance: number;
}
