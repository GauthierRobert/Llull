/** Types of the mesh-processing port (07 MSH TR-MSH-02): see engine.ts for the registry and routing. */

import type { BooleanOp, MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import type { MeshAnalysis } from './analysis';
import type { DecimateParams } from './decimate';
import type { DeviationSummary } from './deviation';
import type { HoleSelect } from './holeFill';
import type { Fairing } from './holeRefine';
import type { SegmentParams, Segmentation } from './segment';
import type { RemeshParams } from './remesh';
import type { RepairMode, SmallComponentRule } from './repair';
import type { SculptParams } from './sculpt';
import type { SmoothParams } from './smooth';

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
  | {
      readonly op: 'repair';
      readonly mode: RepairMode;
      readonly weldTolerance: number;
      readonly maxGap: number;
      readonly smallComponents?: SmallComponentRule;
      readonly maxBoundaryEdges: number;
    }
  | {
      readonly op: 'fill_holes';
      readonly select: HoleSelect;
      readonly maxBoundaryEdges: number;
      readonly fairing: Fairing;
      readonly refine: boolean;
      readonly alpha?: number;
    }
  | ({ readonly op: 'decimate' } & DecimateParams)
  | ({ readonly op: 'remesh' } & RemeshParams)
  | ({ readonly op: 'smooth' } & SmoothParams)
  | { readonly op: 'deviation'; readonly other: MeshInput; readonly maxSamples: number }
  | ({ readonly op: 'segment' } & SegmentParams)
  | ({ readonly op: 'sculpt' } & SculptParams)
  | {
      readonly op: 'cut';
      readonly origin: Vec3;
      readonly normal: Vec3;
      readonly side: 1 | -1;
      readonly cap: boolean;
      readonly epsilon: number;
    }
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
  /** Regions and their primitives (op `segment`, query). */
  readonly segmentation?: Segmentation;
  /** Symmetric deviation of the input from `other` (op `deviation`, query). */
  readonly deviation?: DeviationSummary;
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
