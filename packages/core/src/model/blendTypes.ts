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
 * edge of the source that meets there (unique edge indices) with distance 0 for the edges left to the rolling ball (rounded by the kernel, cut by the same ball; at least
 * one edge has a distance > 0), how far from the vertex its blend stops (along the edge, or the radius of a ball around the vertex on a curved edge or face; document units); the
 * kernel fills the corner with a patch G1 to the blends and the support faces.
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
