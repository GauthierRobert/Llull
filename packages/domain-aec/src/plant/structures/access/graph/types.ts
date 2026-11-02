/** Shapes of the access graph (06 STA §5.7). Lengths are millimetres, whatever the document units. */

import type { Box, Region } from './regions';

export const GRADE_ID = 'grade';

/** Hard caps (checked before anything is allocated): a larger model is refused with `STA_ACCESS_GRAPH_LIMIT`. */
export const GRAPH_LIMITS = {
  /** Slabs plus grating panels read from the model. */
  rawSurfaces: 5000,
  /** Ladders plus stairs. */
  connectors: 5000,
  /** Exact outline tests between touching candidates. */
  contactTests: 400_000,
  /** Targets of one `check_reachability`. */
  targets: 5000,
} as const;

/** Vertical tolerances, mm: a connector end meets a surface within `CONNECT_Z_MM` and `CONNECT_REACH_MM` in plan (§5.7); surfaces touch within `CONTACT_Z_MM`. */
export const CONNECT_Z_MM = 50;
export const CONNECT_REACH_MM = 600;
export const CONTACT_Z_MM = 20;
/** Plan gap that still counts as touching (the 10 mm end-cover tolerance of the grating supports). */
export const CONTACT_GAP_MM = 10;

export type SurfaceKind = 'grade' | 'slab' | 'grating' | 'platform' | 'circular_platform';

/** A node of the graph: grade, or a walkable surface (slab, loose grating panel, or a platform assembly with all its panels). */
export interface SurfaceNode {
  readonly id: string;
  readonly kind: SurfaceKind;
  /** Element ids behind the node (panels of a platform), ascending in model order. */
  readonly members: readonly string[];
  readonly levelId: string | null;
  readonly mark: string;
  /** Absolute top, mm. */
  readonly topMm: number;
  /** Depth of the walking surface below its top (slab thickness, bar depth), mm. */
  readonly thicknessMm: number;
  readonly regions: readonly Region[];
  readonly box: Box;
  readonly areaM2: number;
}

export type EdgeKind = 'ladder' | 'stair' | 'adjacent';

export interface AccessEdge {
  /** The ladder / stair element id; `adjacent:<a>|<b>` for two surfaces that touch. */
  readonly id: string;
  readonly kind: EdgeKind;
  readonly mark: string;
  readonly from: string;
  readonly to: string;
  /** Clear width: between the stiles of a ladder, of a stair; null for a touching pair. */
  readonly clearWidthMm: number | null;
  /** Vertical climb from `from` to `to`, mm (0 for a touching pair). */
  readonly riseMm: number;
}

/** A ladder or stair that did not become an edge: the answer says why, so an unconnected connector is never silent. */
export interface DanglingConnector {
  readonly elementId: string;
  readonly mark: string;
  readonly kind: 'ladder' | 'stair';
  readonly reason: string;
}

export interface AccessGraph {
  /** `grade` first, then the surfaces in model order. */
  readonly nodes: readonly SurfaceNode[];
  readonly edges: readonly AccessEdge[];
  readonly dangling: readonly DanglingConnector[];
  /** Elevation of the lowest level, mm. */
  readonly gradeMm: number;
}

export interface GraphRefusal {
  readonly code: 'STA_NO_GRADE' | 'STA_ACCESS_GRAPH_LIMIT';
  readonly message: string;
}

export const isRefusal = (built: AccessGraph | GraphRefusal): built is GraphRefusal => 'code' in built;
