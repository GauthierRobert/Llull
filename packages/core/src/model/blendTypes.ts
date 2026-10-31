import type { Vec3 } from './vectors';

/** Blend section profiles (BLD M2, docs/design/06-variable-blends/TECHNICAL_SPEC.md §3, §5.3): kept apart from the near-full `types.ts`. */

/**
 * Cross-section of an edge blend: `circular` (default, the kernel's rolling ball), `conic` (rational quadratic with weight rho / (1 - rho) between
 * the contact points and the corner: rho = sqrt 2 - 1 is the circle at 90 degrees) or `curvature` (quartic with zero curvature at both contacts: G2
 * to planar faces; `shape` places the inner control points at that fraction of the way to the corner).
 */
export type BlendProfile =
  | { readonly type: 'circular' }
  | { readonly type: 'conic'; readonly rho: number }
  | { readonly type: 'curvature'; readonly shape: number };

/**
 * A resolved setback corner of a `fillet` node (BLD M3, docs/design/06-variable-blends/TECHNICAL_SPEC.md §5.5): the vertex position and, for every
 * edge of the source that meets there (unique edge indices), how far from the vertex (along the edge, document units) its blend stops; the kernel
 * fills the corner with a patch G1 to the blends and the support faces.
 */
export interface SetbackCorner {
  readonly vertex: Vec3;
  readonly type: 'setback';
  readonly distances: ReadonlyArray<{ readonly edge: number; readonly distance: number }>;
}

/** Smallest and largest `rho` / `shape` (inclusive). */
export const PROFILE_FACTOR_MIN = 0.05;
export const PROFILE_FACTOR_MAX = 0.95;

/** Fields of a `faceBlend` recipe node besides `source` (BLD M4): unique face indices of the source, the ball radius in document units, the section. */
export interface FaceBlendParams {
  readonly facesA: readonly number[];
  readonly facesB: readonly number[];
  readonly radius: number;
  readonly profile?: BlendProfile;
}

/** Fields of a `fullRound` recipe node besides `source` (BLD M4): the two parallel side faces and the center face the half-round consumes. */
export interface FullRoundParams {
  readonly side1: readonly number[];
  readonly center: readonly number[];
  readonly side2: readonly number[];
}

/** A joint radius of `blend_union` (BLD M5): the joint (and its tangent chain) nearest to `near` is rounded with `radius` (document units). */
export interface JointRadius {
  readonly near: Vec3;
  readonly radius: number;
}

/**
 * `edges`: 0-based indices into the source's unique edges (`ShapeTopology.edges`); [] = all. `sizeEnd` (fillet only): radius at each
 * edge's end, varying linearly from `size` at its start. `near`: the mid point of each selected edge at creation (document frame), so code
 * generators can pick the same edges by position when the kernel's edge indices are unavailable; kernels ignore it.
 * `radii` (fillet only): one law per entry of `edges` (same length, edges non-empty); `size` is then the placeholder 0, so a kernel that
 * does not read `radii` refuses instead of rounding every edge with one radius.
 * `faces` (chamfer only, BLD M1): per entry of `edges` the unique face index carrying the first leg `size`; with it, `size2` is the second leg
 * (distance-distance) or `angleDeg` the angle in degrees (0, 90) measured on that face (distance-angle); exactly one of the two. With `sizeEnd` both legs run linearly start to end (BLD M5): `size2` -> `size2End`, no angle.
 */
export interface EdgeBlendNode<Source, Radius> {
  readonly op: 'fillet' | 'chamfer';
  readonly source: Source;
  readonly edges: readonly number[];
  readonly size: number;
  readonly sizeEnd?: number;
  readonly radii?: readonly Radius[];
  readonly near?: readonly Vec3[];
  readonly faces?: readonly number[];
  readonly size2?: number;
  readonly size2End?: number;
  readonly angleDeg?: number;
  /** Fillet only (BLD M2): conic / curvature section; absent or circular = the rolling ball. A non-circular profile needs constant sizes. */
  readonly profile?: BlendProfile;
  /** Fillet only (BLD M3): setback corners; a vertex without an entry keeps the kernel's rolling-ball corner. */
  readonly corners?: readonly SetbackCorner[];
}
