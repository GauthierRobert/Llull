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

/** Laws of the axis-driven deformations, the affine map, the free-form lattice, the point push and the flow along a curve (local frame coordinates). */
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
  | { readonly kind: 'bend'; readonly radius: number; readonly symmetric: boolean }
  /** Free-form deformation (Sederberg & Parry 1986): Bernstein lattice of degrees [l, m, n] over `box` (frame coordinates); control point (i, j, k) is displaced by its offset; points outside the box stay. */
  | {
      readonly kind: 'lattice';
      readonly box: { readonly min: Vec3; readonly max: Vec3 };
      readonly degrees: readonly [number, number, number];
      readonly offsets: ReadonlyArray<{ readonly index: readonly [number, number, number]; readonly delta: Vec3 }>;
    }
  /** Push of the points within `radius` of `center` (frame coordinates) along the unit `direction` by `distance` x falloff(|p - center| / radius). */
  | {
      readonly kind: 'point';
      readonly center: Vec3;
      readonly direction: Vec3;
      readonly distance: number;
      readonly radius: number;
      readonly falloff: 'smooth_c2' | 'cubic';
    }
  /**
   * Flow of the frame axis onto a curve: the point (x, y, z) goes to P(s) + x N(s) + y B(s), s = ratio (z - z0), where (P, N, B) is a frame along the
   * target curve sampled at uniform arc length `step` (12 numbers per station: P, T, N, B). Beyond the table the ends continue straight.
   */
  | {
      readonly kind: 'flowCurve';
      readonly z0: number;
      readonly ratio: number;
      readonly step: number;
      readonly stations: ReadonlyArray<number>;
    }
  /**
   * Flow of a base plane onto a surface (flow_on_surface): the point (x, y, w) goes to P(x, y) + w N(x, y), x and y arc lengths on the target. P and N are tabulated on
   * the regular grid x0 + i hx, y0 + j hy (nx by ny nodes, six numbers each: P then N, i-major); bicubic Catmull-Rom between nodes, clamped outside.
   */
  | {
      readonly kind: 'flowSurface';
      readonly x0: number;
      readonly y0: number;
      readonly hx: number;
      readonly hy: number;
      readonly nx: number;
      readonly ny: number;
      readonly nodes: ReadonlyArray<number>;
    }
  /**
   * Displacement field fitted to curve pairs (deform_curve_to_curve): p goes to p + a0 + A p + Σ w_i |p - c_i|^3, the triharmonic spline through the displacements of the
   * constraint points c_i. `centres` and `weights` hold three numbers per centre; `affine` is a0 (3 numbers) then the rows of A.
   */
  | {
      readonly kind: 'rbf';
      readonly centres: ReadonlyArray<number>;
      readonly weights: ReadonlyArray<number>;
      readonly affine: ReadonlyArray<number>;
    };

export type DeformLawKind = DeformLaw['kind'];

export const DEFORM_LAW_KINDS: readonly DeformLawKind[] = [
  'affine',
  'twist',
  'taper',
  'stretch',
  'bend',
  'lattice',
  'point',
  'flowCurve',
  'flowSurface',
  'rbf',
];

/** Laws driven by a region along the frame axis (the others act where their own data says). */
export const AXIS_LAW_KINDS: readonly DeformLawKind[] = ['twist', 'taper', 'stretch', 'bend'];

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
