/** Prismatic B-rep from a segmented triangle mesh (07 MSH FR-MSH-21): the request the exact kernel's `meshToBrep` takes and the answer it gives. */

import type { Vec3 } from '../model/vectors';

/** What one group of triangles becomes: an exact face on the analytic surface (parameters of `segment_mesh`), or its triangles as planar faces. */
export type MeshToBrepGroup =
  | { readonly kind: 'plane'; readonly point: Vec3; readonly normal: Vec3 }
  | { readonly kind: 'cylinder'; readonly axisPoint: Vec3; readonly axis: Vec3; readonly radius: number }
  | { readonly kind: 'cone'; readonly apex: Vec3; readonly axis: Vec3; readonly halfAngleRad: number }
  | { readonly kind: 'sphere'; readonly center: Vec3; readonly radius: number }
  | { readonly kind: 'faceted' };

export interface MeshToBrepRequest {
  /** xyz per vertex of a closed, welded, outward-wound mesh (document units). */
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  /** Group of every triangle (index into `groups`). */
  readonly faceGroup: readonly number[];
  readonly groups: readonly MeshToBrepGroup[];
  /** Sewing and curve-following tolerance (document units). */
  readonly tolerance: number;
}

interface MeshToBrepReport {
  readonly valid: boolean;
  readonly volume: number;
  readonly area: number;
  readonly freeEdges: number;
  readonly multipleEdges: number;
  readonly exactFaces: number;
  readonly facetedFaces: number;
  readonly exactChains: number;
  readonly polylineChains: number;
  /** Exact faces by surface type. */
  readonly built: Readonly<Record<string, number>>;
  /** Indices of the groups that stayed triangles. */
  readonly facetedGroups: readonly number[];
  /** Why a group stayed triangles, one line each. */
  readonly notes?: readonly string[];
}

export interface MeshToBrepResult {
  readonly ok: boolean;
  readonly error?: string;
  /** `BRepTools::Write` text of the solid (the document blob format `occt-brep-v1`). */
  readonly brep?: string;
  readonly report?: MeshToBrepReport;
}
