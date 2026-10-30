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
import type { DisplaceParams, ShrinkwrapParams } from './wrapDisplace';
import type { SmoothParams } from './smooth';

/**
 * Ask the engine to measure the symmetric deviation of the op's result from its input in the same job (TECHNICAL_SPEC 13.9): `maxSamples` as in the
 * `deviation` op. An engine that can does so and answers it in `MeshOpResult.deviation`; one that cannot leaves it out and the caller measures separately.
 */
interface WithDeviation {
  readonly withDeviation?: number;
}

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
  | ({
      readonly op: 'repair';
      readonly mode: RepairMode;
      readonly weldTolerance: number;
      readonly maxGap: number;
      readonly smallComponents?: SmallComponentRule;
      readonly maxBoundaryEdges: number;
    } & WithDeviation)
  | ({
      readonly op: 'fill_holes';
      readonly select: HoleSelect;
      readonly maxBoundaryEdges: number;
      readonly fairing: Fairing;
      readonly refine: boolean;
      readonly alpha?: number;
    } & WithDeviation)
  | ({ readonly op: 'decimate' } & DecimateParams & WithDeviation)
  | ({ readonly op: 'remesh' } & RemeshParams & WithDeviation)
  | ({ readonly op: 'smooth' } & SmoothParams & WithDeviation)
  | { readonly op: 'deviation'; readonly other: MeshInput; readonly maxSamples: number }
  | ({
      readonly op: 'quad_remesh';
      /** Wanted number of output quads (the engine lands within about 15 % of it). */
      readonly targetQuads: number;
      /** Smaller quads where the surface curves more. */
      readonly adaptive: boolean;
      /** Align the quads to edges whose faces meet at more than this angle; absent = no alignment. */
      readonly hardEdgeRad?: number;
      /** The input is an open surface (or the half of a symmetric one): keep its boundary, the quads follow it. */
      readonly preserveBoundary?: boolean;
    } & WithDeviation)
  | {
      /** Harmonic map of the WHOLE input mesh (one disk-topology region) onto the unit square (13.23 / 13.26); the answer is `MeshOpResult.harmonic`, not a mesh. */
      readonly op: 'harmonic_map';
      /** Iterations per coordinate a solve may take (default: the budget of the region). */
      readonly maxIterations?: number;
    }
  | ({ readonly op: 'segment' } & SegmentParams)
  | ({ readonly op: 'sculpt' } & SculptParams)
  | ({ readonly op: 'shrinkwrap'; readonly target: MeshInput } & ShrinkwrapParams)
  | ({ readonly op: 'displace' } & DisplaceParams)
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

/** An indexed quad mesh: world-space positions (xyz per vertex) and four vertex indices per quad, counter-clockwise seen from outside. */
export interface QuadMeshData {
  readonly positions: readonly number[];
  readonly quads: readonly number[];
}

/** The harmonic map of a region as the engines answer it (`harmonicMap.ts` shapes it as a `Map`). */
export interface HarmonicResult {
  /** The vertices of the region, ascending (vertex numbers of the input mesh), and their parameters (u, v) in the same order: two numbers each. */
  readonly vertices: ReadonlyArray<number>;
  readonly uv: ReadonlyArray<number>;
  readonly weights: 'cotangent' | 'mean_value';
  readonly flippedFirst: number;
  readonly collapsedInParameters: number;
  readonly interiorVertices: number;
  readonly boundaryVertices: number;
  readonly cgIterations: number;
  readonly cgResidual: number;
  readonly corners: readonly [number, number, number, number];
}

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
  /** Parameters of the region (op `harmonic_map`, query). */
  readonly harmonic?: HarmonicResult;
  /** Regions and their primitives (op `segment`, query). */
  readonly segmentation?: Segmentation;
  /** Result of op `quad_remesh` (instead of `mesh`). */
  readonly quads?: QuadMeshData;
  /** Symmetric deviation of the input from `other` (op `deviation`), or of the op's result from its input (decimate, smooth, remesh, repair, fill_holes, quad_remesh asked with `withDeviation`). */
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
  /**
   * Per op, the input size (triangles) above which this engine is asked BEFORE the engines listed earlier, because it is faster there even with its job round
   * (the native engine; measured in TECHNICAL_SPEC 13.12). Absent = never preferred. The results must be identical to the engines it goes ahead of.
   */
  preferredAbove?(): ReadonlyMap<MeshOpName, number>;
  run(input: MeshInput, op: MeshOp): MeshOpResult | MeshEngineFailure;
}

export const isEngineFailure = (value: MeshOpResult | MeshEngineFailure): value is MeshEngineFailure => 'code' in value;

/** Largest input (triangles) the TypeScript engine accepts per op before asking for a faster engine. */
export const MESH_TS_TRIANGLE_CAP = 200_000;

/**
 * Largest input (triangles) the TypeScript engine accepts for `cut`: one pass over the triangles and a cap per section loop, 1.3 s and about 140 MB beyond the input at
 * 1,310,720 triangles (TECHNICAL_SPEC 13.15.1), so it is lifted instead of ported. The loop is synchronous: a cut of 4,000,000 triangles holds the event loop for 3 to 10 s.
 */
export const MESH_TS_CUT_CAP = 4_000_000;

/** Largest region (triangles) the TypeScript engine maps harmonically: the solve runs on the caller's thread, about 1 to 2 s at this size on a badly jittered mesh (13.23.2). */
export const MESH_TS_HARMONIC_CAP = 25_000;

/** Most points one hull call takes (the cap of the `hull` op, which has no input mesh). */
export const MESH_HULL_POINT_LIMIT = 1_000_000;

export const emptyMeshInput: MeshInput = { mesh: { positions: [], indices: [] } };
