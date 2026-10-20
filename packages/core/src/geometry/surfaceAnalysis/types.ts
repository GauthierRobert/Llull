/**
 * Types of the surface-analysis port (02 SRF M4): requests and reports in WORLD coordinates, and the engine interface (see `port.ts`).
 * @invariant a conforming engine reproduces the default engine up to its declared `provenance.exact`
 */

import type { Vec3 } from '../../model/vectors';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { SurfaceSample } from '../../lib/nurbs/surfaceCurvature';
import type { Triangle } from '../triangleQueries';

export type SurfaceSide = 'u0' | 'u1' | 'v0' | 'v1';

/** One side of a joint: a whole curve (its nearest end joins) or one boundary edge of a patch. */
export type ContinuityEdge =
  | { readonly type: 'curve'; readonly curve: NurbsCurveData }
  | { readonly type: 'surface'; readonly surface: NurbsSurfaceData; readonly side: SurfaceSide };

export interface ContinuityTolerances {
  /** Largest position gap (document units) still counted as G0. */
  readonly g0: number;
  /** Largest angle between normals / tangents (radians) still counted as G1. */
  readonly g1AngleRad: number;
  /** Relative curvature jump |k_a - k_b| / max(|k_a|, |k_b|) still counted as G2 ... */
  readonly g2Rel: number;
  /** ... or an absolute jump (1/length) below which curvatures are equal. */
  readonly g2Abs: number;
  /** Relative jump of d(curvature)/ds still counted as G3 (curves only). */
  readonly g3Rel: number;
}

export type ContinuityOrder = 'none' | 'G0' | 'G1' | 'G2' | 'G3';

export interface ContinuitySample {
  /** Position along the first edge, 0..1. */
  readonly t: number;
  readonly point: Vec3;
  readonly g0Gap: number;
  readonly g1AngleRad: number;
  readonly g2Gap: number;
  readonly g3Gap: number | null;
}

export interface ContinuityJoint {
  readonly samples: ReadonlyArray<ContinuitySample>;
  readonly g0Gap: number;
  readonly g1AngleRad: number;
  readonly g2Gap: number;
  /** Largest relative curvature jump over the samples (0 when both curvatures are below `g2Abs`). */
  readonly g2Rel: number;
  /** Curves only (surfaces: null, third-order surface continuity is not measured). */
  readonly g3Gap: number | null;
  readonly order: ContinuityOrder;
  readonly worst: { readonly t: number; readonly point: Vec3 };
}

export type DeviationShape =
  | { readonly type: 'surface'; readonly surface: NurbsSurfaceData }
  | { readonly type: 'curve'; readonly curve: NurbsCurveData }
  | { readonly type: 'mesh'; readonly triangles: ReadonlyArray<Triangle> }
  | { readonly type: 'points'; readonly points: ReadonlyArray<Vec3> };

export interface DeviationRequest {
  /** Where the samples are taken (points: as given; surface: a grid; curve: a polyline; mesh: its vertices and centroids). */
  readonly from: DeviationShape;
  /** What the distance is measured to: surface, curve or mesh. */
  readonly to: Exclude<DeviationShape, { type: 'points' }>;
  /** Sample count per direction of a surface / count along a curve (ignored for points and meshes). */
  readonly samples: number;
}

export interface DeviationReport {
  readonly count: number;
  readonly max: number;
  readonly mean: number;
  readonly rms: number;
  readonly p95: number;
  readonly worst: { readonly point: Vec3; readonly foot: Vec3; readonly distance: number };
  /** Mean / extreme of the distance signed along the target surface normal (surface targets only). */
  readonly signed: { readonly mean: number; readonly min: number; readonly max: number } | null;
  /** Ten equal bins from 0 to `max`: how many samples fall in each. */
  readonly histogram: ReadonlyArray<number>;
}

export interface DraftRequest {
  readonly shape:
    | { readonly type: 'surface'; readonly surface: NurbsSurfaceData }
    | { readonly type: 'mesh'; readonly triangles: ReadonlyArray<Triangle> };
  /** Unit direction the part is pulled from the mould. */
  readonly pull: Vec3;
  readonly minDraftDeg: number;
  /** Surface sample count per direction. */
  readonly grid: number;
  /** Surface normals are flipped (sheets have no inside; solids / meshes use their outward normals unchanged). */
  readonly flip: boolean;
}

export interface DraftSample {
  readonly point: Vec3;
  readonly draftDeg: number;
  /** Area represented by the sample (document units squared). */
  readonly area: number;
}

export interface DraftReport {
  readonly samples: ReadonlyArray<DraftSample>;
  readonly minDeg: number;
  readonly maxDeg: number;
  readonly totalArea: number;
  readonly areaBelowMin: number;
  readonly undercutArea: number;
}

export interface SurfaceAnalysisEngine {
  readonly provenance: { readonly engine: string; readonly exact: boolean };
  /** Local geometry (normal, k1, k2, K, H...) of `surface` at each (u, v). */
  curvature(surface: NurbsSurfaceData, parameters: ReadonlyArray<readonly [number, number]>): SurfaceSample[];
  /** Continuity of the joint between two edges. `samples` positions along edge a (>= 2); null when the edges do not meet within `search`. */
  continuity(a: ContinuityEdge, b: ContinuityEdge, samples: number, tolerances: ContinuityTolerances): ContinuityJoint;
  deviation(request: DeviationRequest): DeviationReport;
  draft(request: DraftRequest): DraftReport;
}
