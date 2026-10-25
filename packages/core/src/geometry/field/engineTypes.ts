/** Field-engine port types (05 IMP TR-IMP-02): the contract between commands, the TS engine and a native engine. */

import type { MeshData, Vec3 } from '../../model/types';
import type { FieldProgram } from './program';

export interface FieldGrid {
  readonly min: Vec3;
  readonly max: Vec3;
  /** Node spacing; the grid has ceil((max - min) / voxel) cells per axis. */
  readonly voxel: number;
}

export interface FieldProvenance {
  readonly engine: string;
  readonly device: string;
  readonly deterministic: boolean;
  readonly voxel: number;
}

export interface FieldSamples {
  /** One value per point. */
  readonly values: Float64Array;
  /** Three per point (d/dx, d/dy, d/dz) when requested. */
  readonly gradients: Float64Array | null;
  /** Samples whose value was NaN / infinite (counted, treated as outside). */
  readonly nonFinite: number;
  /** Set when the engine could not evaluate (then `values` are NaN and must not be used): the caller refuses with this code and message. */
  readonly failure?: { readonly code: 'IMP_ENGINE_FAILED'; readonly message: string };
}

export type Mesher = 'tetra' | 'dual_contouring';

export interface MeshOptions {
  /** tetra: marching tetrahedra (always closed and manifold); dual_contouring: sharp features kept, falls back to the tetrahedra when its result is not manifold. */
  readonly mesher: Mesher;
  /** Refuse (IMP_TRIANGLE_BUDGET) a result with more triangles. */
  readonly maxTriangles: number;
}

export interface FieldMeshResult {
  readonly ok: true;
  readonly mesh: MeshData;
  readonly closedManifold: boolean;
  /** Grid nodes (the budgeted quantity). */
  readonly samples: number;
  /** Nodes actually evaluated (the rest were proved empty / full by interval pruning). */
  readonly evaluatedSamples: number;
  readonly prunedFraction: number;
  /** Largest |f| at a mesh vertex (distance of the vertex from the exact surface for an exact field). */
  readonly maxVertexResidual: number;
  readonly nonFiniteSamples: number;
  /** The mesher that produced `mesh` (dual contouring reports `tetra` when it fell back). */
  readonly mesher: Mesher;
  readonly mesherFallback: boolean;
  readonly provenance: FieldProvenance;
}

export interface FieldRefusal {
  readonly ok: false;
  readonly code: 'IMP_GRID_BUDGET' | 'IMP_TRIANGLE_BUDGET' | 'IMP_ENGINE_FAILED';
  readonly message: string;
  readonly samples?: number;
  readonly limit?: number;
}

/** Component of the sign grid (solid pieces, or voids of the complement). */
export interface FieldComponent {
  readonly voxels: number;
  readonly volume: number;
  /** A grid node inside the component (the first in scan order). */
  readonly point: Vec3;
  /** Voids only: true when the void does not touch the grid boundary (enclosed). */
  readonly enclosed: boolean;
}

export type MeasureRequest =
  | {
      /** Volume of {f <= 0} (clipped to {region <= 0} when a region is given) by quadrature over the grid box; each cell counts whole by its sample (hard threshold), cells tile the box exactly. */
      readonly kind: 'volume';
      /** `midpoint`: cell-centre grid; `lowdiscrepancy`: R3 sequence (aligned strut lattices alias on the grid, F7). */
      readonly sampling: 'midpoint' | 'lowdiscrepancy';
    }
  | {
      /** Sorted-sample quantiles of f (or |f|) over the grid box: the exact inverse of the sampled fraction. */
      readonly kind: 'quantile';
      readonly probabilities: readonly number[];
      readonly absolute: boolean;
    }
  | {
      /** The node sign grid itself (1 = inside the closed set {f < 2e-3 voxel}, clipped to the region), x fastest: the input of thickness analyses. */
      readonly kind: 'nodes';
    }
  | {
      /** Connected components of {f < 0} (6-connectivity) and of its complement (26-connectivity) on the grid nodes. */
      readonly kind: 'components';
    };

type FieldMeasures =
  | {
      readonly ok: true;
      readonly kind: 'nodes';
      readonly inside: Uint8Array;
      readonly nodes: readonly [number, number, number];
      readonly samples: number;
      readonly provenance: FieldProvenance;
    }
  | {
      readonly ok: true;
      readonly kind: 'volume';
      /** Volume of the clipped solid. */
      readonly volume: number;
      /** Volume of the region (or of the box when no region). */
      readonly regionVolume: number;
      readonly samples: number;
      readonly nonFiniteSamples: number;
      readonly provenance: FieldProvenance;
    }
  | {
      readonly ok: true;
      readonly kind: 'quantile';
      readonly values: readonly number[];
      readonly samples: number;
      readonly provenance: FieldProvenance;
    }
  | {
      readonly ok: true;
      readonly kind: 'components';
      readonly solids: readonly FieldComponent[];
      readonly voids: readonly FieldComponent[];
      readonly samples: number;
      readonly provenance: FieldProvenance;
    };

/** Determinism class of the TS and the native engine (IEEE-754 doubles with V8's libm results). */
export const DEFAULT_DETERMINISM = 'js-ieee754-v8';

export interface FieldEngine {
  /** 'ts' | 'llull-field'. */
  readonly name: string;
  /** Class of results the engine guarantees bit for bit (default `DEFAULT_DETERMINISM`): two engines of one class mesh a field identically, so a body's content hash does not name the engine. */
  readonly determinism?: string;
  readonly limits: {
    readonly maxSamples: number;
    readonly maxTriangles: number;
    /** Triangle budget when the host keeps the full mesh in its mesh asset store (the document then holds a display level of detail only). */
    readonly maxStoredTriangles?: number;
  };
  evaluate(program: FieldProgram, points: Float64Array, withGradient: boolean): FieldSamples;
  mesh(program: FieldProgram, grid: FieldGrid, options: MeshOptions): FieldMeshResult | FieldRefusal;
  measure(program: FieldProgram, grid: FieldGrid, region: FieldProgram | null, request: MeasureRequest): FieldMeasures | FieldRefusal;
}

/** Cells per axis of `grid` (at least 1). */
export function gridCells(grid: FieldGrid): [number, number, number] {
  const cells = (axis: 0 | 1 | 2): number => Math.max(1, Math.ceil((grid.max[axis] - grid.min[axis]) / grid.voxel - 1e-9));
  return [cells(0), cells(1), cells(2)];
}

/** Grid nodes (cells + 1 per axis). */
export function gridNodeCount(grid: FieldGrid): number {
  const [nx, ny, nz] = gridCells(grid);
  return (nx + 1) * (ny + 1) * (nz + 1);
}
