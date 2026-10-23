/** Shared types of the advanced loft builder (SWG M5/M7): the request (`LoftOptions`), what it makes (`LoftBuilt`) and the refusals (`LoftIssue`). */

import type { Vec3 } from '../../model/vectors';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { NurbsCurveData } from '../../lib/nurbs/types';

/** How a loft leaves its first or last section. */
export type EndRequest =
  | { readonly type: 'normal'; readonly magnitude: number; readonly draftDeg?: number | undefined }
  | { readonly type: 'direction'; readonly direction: Vec3; readonly magnitude: number }
  | { readonly type: 'face'; readonly surface: NurbsSurfaceData; readonly magnitude: number; readonly curvature: boolean }
  | { readonly type: 'point'; readonly at: Vec3 };

export interface LoftOptions {
  /** Straight lines between neighbouring sections (degree 1 across) instead of a smooth skin. */
  readonly ruled: boolean;
  /** Join the last section back to the first (periodic across, >= 3 sections). */
  readonly closed: boolean;
  /** Sections are closed curves of a solid: wound alike about the direction of travel, planar caps added by the kernel. */
  readonly solid: boolean;
  /** Seam alignment of closed sections: `auto` moves each start to the nearest point to the previous start, `seams` uses `seams`, `none` keeps them. */
  readonly alignment: 'auto' | 'none' | 'seams';
  /** Per section, the curve-parameter fraction (0..1) at which its seam goes (alignment `seams`). */
  readonly seams?: readonly number[] | undefined;
  /** Pair sections' vertices: `arc_length` (equal arc-length fractions, split at corners) or `vertices` (the fractions of `vertexPairs`). */
  readonly coupling?: 'arc_length' | 'vertices' | undefined;
  /** Per section, ascending curve-parameter fractions (0..1) of its vertices; every section lists the same number. */
  readonly vertexPairs?: ReadonlyArray<readonly number[]> | undefined;
  readonly start?: EndRequest | undefined;
  readonly end?: EndRequest | undefined;
  /** Two sections only: this curve carries `sectionCount` blended intermediate sections placed normal to it. */
  readonly centerline?: NurbsCurveData | undefined;
  readonly sectionCount?: number | undefined;
  /** Guide curves crossing every section (a Gordon surface through the network). */
  readonly guides?: readonly NurbsCurveData[] | undefined;
  readonly guideTolerance: number;
  /** Largest deviation (document units) of arc-length refits from the original curves. */
  readonly fitTolerance: number;
  /** Largest angle (radians) between a loft end and its target direction / face before the section is refined. */
  readonly endAngleTolerance: number;
  /** Largest distance (document units) from an end section to its reference face. */
  readonly faceTolerance: number;
}

export interface LoftReport {
  /** Largest distance from the final sections to the skin. */
  readonly sectionDeviation: number;
  /** Largest angle (radians) between the skin across the first / last section and its target; null for a free end. */
  readonly startAngleRad: number | null;
  readonly endAngleRad: number | null;
  /** Number of faces the skin is made of (1 unless coupled at corners / vertices). */
  readonly faceCount: number;
  /** Largest refit deviation of an arc-length coupling (0 when no refit). */
  readonly fitDeviation: number;
  /** Largest twist (radians) between the rulings of neighbouring sections at the seam: how far the sections are from aligned. */
  readonly seamTwistMaxRad: number;
  /** Largest distance from a guide to the skin (Gordon), null without guides. */
  readonly guideDeviation: number | null;
  /** Closed loft: largest angle (radians) between the skin's tangents across the closing seam (0 = G1), null otherwise. */
  readonly closureJumpRad: number | null;
}

export interface LoftBuilt {
  readonly faces: NurbsSurfaceData[];
  /** The sections as finally skinned (wound, aligned, with the centreline's intermediates). */
  readonly sections: NurbsCurveData[];
  readonly report: LoftReport;
}

type LoftIssueCode =
  | 'SRF_LOFT_SECTIONS_TOO_FEW'
  | 'SRF_NURBS_INVALID'
  | 'SRF_LOFT_GUIDE_MISSES_SECTION'
  | 'SRF_LOFT_GUIDE_NOT_CONTAINED'
  | 'SWG_LOFT_END_CONDITION_INVALID'
  | 'SWG_LOFT_FACE_NOT_ADJACENT'
  | 'SWG_LOFT_COUPLING_MISMATCH'
  | 'SWG_LOFT_CENTERLINE_MISSES'
  | 'SWG_LOFT_CLOSED_TOO_FEW'
  | 'SWG_SECTION_INVALID'
  | 'SWG_FIT_TOLERANCE'
  | 'SWG_PARAM_INVALID';

export interface LoftIssue {
  readonly code: LoftIssueCode;
  readonly message: string;
  readonly section?: number;
}
