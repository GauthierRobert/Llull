/** Types of the mesh-processing port (07 MSH TR-MSH-02): see engine.ts for the registry and routing. */

import type { BooleanOp, MeshData } from '../../model/types';
import type { MeshAnalysis } from './analysis';

export interface MeshInput {
  readonly mesh: MeshData;
}

export type MeshOp =
  | { readonly op: 'analyze'; readonly weldTolerance: number; readonly selfIntersections: boolean; readonly maxListed: number }
  | { readonly op: 'hull'; readonly points: ReadonlyArray<number> }
  | { readonly op: 'minkowski'; readonly kind: 'sum' | 'difference'; readonly other: MeshInput }
  | {
      readonly op: 'offset';
      readonly method: 'level_set' | 'normal';
      readonly distance: number;
      readonly tolerance: number;
      readonly maxCells: number;
    }
  | { readonly op: 'hollow'; readonly wall: number; readonly tolerance: number; readonly maxCells: number }
  | { readonly op: 'wrap'; readonly tolerance: number; readonly maxCells: number }
  | { readonly op: 'boolean'; readonly kind: BooleanOp; readonly others: ReadonlyArray<MeshInput> }
  | {
      readonly op: 'subdivide';
      readonly method: 'midpoint' | 'loop' | 'smooth';
      readonly levels: number;
      readonly maxEdge?: number;
      readonly featureAngleDeg: number;
    };

export type MeshOpName = MeshOp['op'];

export interface MeshProvenance {
  readonly engine: 'ts' | 'manifold' | 'native';
  /** Library/version string, e.g. `manifold-3d@3.5.4`. */
  readonly version: string;
  readonly algorithm: string;
  readonly reference: string;
  readonly deterministic: true;
}

export interface MeshOpResult {
  /** Result triangles, indexed (absent for query ops). */
  readonly mesh?: MeshData;
  readonly analysis?: MeshAnalysis;
  /** Op-specific counts and parameters actually used (document units). */
  readonly report: Readonly<Record<string, unknown>>;
  readonly provenance: MeshProvenance;
}

export interface MeshEngineFailure {
  readonly code: string;
  readonly message: string;
}

export interface MeshProcessingEngine {
  readonly name: string;
  /** Ops this engine answers and its input-triangle cap per op (Infinity = none). */
  capabilities(): ReadonlyMap<MeshOpName, number>;
  run(input: MeshInput, op: MeshOp): MeshOpResult | MeshEngineFailure;
}

export const isEngineFailure = (value: MeshOpResult | MeshEngineFailure): value is MeshEngineFailure => 'code' in value;

/** Largest input (triangles) the TypeScript engine accepts per op before asking for a faster engine. */
export const MESH_TS_TRIANGLE_CAP = 200_000;

/** Most points one hull call takes (the cap of the `hull` op, which has no input mesh). */
export const MESH_HULL_POINT_LIMIT = 1_000_000;

export const emptyMeshInput: MeshInput = { mesh: { positions: [], indices: [] } };
