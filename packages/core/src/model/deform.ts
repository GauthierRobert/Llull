/** Space-deformation data (01 DEF): the laws, frame, region and output settings of a `deform` shape-recipe node. Pure data, no behaviour. */

import type { Vec3 } from './vectors';

/** Local frame: z = axis, x = reference projected perpendicular to the axis, y = z × x. `origin` is a world point (document units). */
export interface DeformFrame {
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly reference: Vec3;
}

/** Region along the frame z axis (document units from the frame origin). */
export interface DeformRegion {
  readonly start: number;
  /** > start. */
  readonly end: number;
  /** Ramp shape: `none` is a step (stretch only), `linear` a straight ramp (creases at both ends), `smooth` 3t² − 2t³ (no crease). */
  readonly falloff: 'none' | 'linear' | 'smooth';
  /** Past the end the body carries the end transform (the only continuous choice for a ramp that ends at its full value). */
  readonly beyond: 'rigid';
}

/** Laws of the axis-driven deformations and of the affine map (local frame coordinates). */
export type DeformLaw =
  /** q' = M q + t with M given by rows. */
  | { readonly kind: 'affine'; readonly matrix: readonly [Vec3, Vec3, Vec3]; readonly translation: Vec3 }
  /** Rotation about the frame axis by `angleRad` × ramp(z). */
  | { readonly kind: 'twist'; readonly angleRad: number }
  /** Lateral scale 1 + (scaleEnd − 1) ramp(z); `flat` scales local x only. */
  | { readonly kind: 'taper'; readonly scaleEnd: number; readonly flat: boolean }
  /** Piecewise-linear stretch along z by `factor` inside the region. */
  | { readonly kind: 'stretch'; readonly factor: number }
  /** Bend of the region onto a circle of `radius` toward local +y; `symmetric` keeps the region middle in place. */
  | { readonly kind: 'bend'; readonly radius: number; readonly symmetric: boolean };

export type DeformLawKind = DeformLaw['kind'];

export const DEFORM_LAW_KINDS: readonly DeformLawKind[] = ['affine', 'twist', 'taper', 'stretch', 'bend'];

export interface DeformOutput {
  /** `auto`: exact when an exact kernel can evaluate the law, else mesh; `exact` refuses without one; `mesh` forces the mesh path. */
  readonly mode: 'auto' | 'exact' | 'mesh';
  /** Maximum chordal deviation of the mesh path (document units, > 0). */
  readonly tolerance: number;
  /** Recognise analytic faces in the exact result (later milestone). */
  readonly preserveAnalytic: boolean;
}

/** The fields of a deform recipe node besides its source (ShapeRecipe in model/types). */
export interface DeformParams {
  readonly law: DeformLaw;
  readonly frame: DeformFrame;
  readonly region?: DeformRegion;
  readonly output: DeformOutput;
}
