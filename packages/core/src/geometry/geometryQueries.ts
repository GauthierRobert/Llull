/**
 * Injected batch mesh-query port (PHY-21 TR-FPR-19, RS1 §2 rule 1). Interface + the always-available TS engine on `meshBvh`; a host may
 * install a faster one (native `llull-compute geomq`) with `setGeometryQueryEngine`. Commands read it from `ctx.geometryQueries` and fall
 * back to `resolveGeometryQueries(...)` (the default engine) when it is null/absent. Synchronous, framework-agnostic, no native imports.
 * @invariant every batch method returns exactly one result per input item, in input order; an empty batch returns []
 * @invariant a conforming engine reproduces the default engine's numbers (same hits, same distances) up to its declared determinism
 */

import type { MeshData, Vec3 } from '../model/types';
import { segmentHitsTriangle } from '../lib/segmentTriangle';
import { type BvhDistance, type BvhRayHit, type MeshBvh, type RigidTransform, buildMeshBvh, bvhMinDistance, bvhRayCast } from './meshBvh';
import type { Triangle } from './triangleQueries';

interface GeometryQueryProvenance {
  /** Engine name, e.g. `meshBvh` or `llull-geomq`. */
  readonly engine: string;
  /** Compute device, e.g. `cpu`, or a GPU adapter name. */
  readonly device: string;
  /** True when the reported numbers are bit-reproducible run to run (Rust-CPU twin or fixed-order reductions). */
  readonly deterministic: boolean;
}

/** Per-engine budgets; the TS engine's values are the historical caps of the callers. */
interface GeometryQueryLimits {
  /** Largest facet count (surfaces + blockers) accepted by `compute_view_factors`. */
  readonly maxViewFactorFacets: number;
  /** Largest total thickness-ray count accepted by `check_assembly`. */
  readonly maxThicknessRays: number;
}

export interface MeshRay {
  readonly origin: Vec3;
  readonly direction: Vec3;
  /** Smallest accepted hit parameter; default 0. */
  readonly tMin?: number;
}

/** Open segment `start`..`end` to test against occluder triangles; occluders listed in `skip` (indices) are ignored. */
export interface OcclusionSegment {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly skip: readonly number[];
}

export interface GeometryQueryEngine {
  readonly provenance: GeometryQueryProvenance;
  readonly limits: GeometryQueryLimits;
  /**
   * Closest surface points of mesh pairs for every pose. `poses[p][m]` places mesh `m` in the world at sample `p` (null = identity);
   * `pairs` are `[i, j]` mesh indices. Result `[p][k]` is the hit of pair k at pose p when within `maxDistance`, else null (distance 0 =
   * surfaces touch or cross); witness points are in mesh i's local frame.
   */
  minDistanceBatch(
    meshes: readonly MeshData[],
    poses: readonly (readonly (RigidTransform | null)[])[],
    pairs: readonly (readonly [number, number])[],
    maxDistance: number,
  ): (BvhDistance | null)[][];
  /** First double-sided surface hit of each ray with t in [tMin, maxT], else null. */
  rayCastBatch(mesh: MeshData, rays: readonly MeshRay[], maxT: number): (BvhRayHit | null)[];
  /** Per segment: true when the open segment crosses the interior of any non-skipped occluder triangle. */
  segmentOcclusionBatch(occluders: readonly Triangle[], segments: readonly OcclusionSegment[]): boolean[];
}

type Mat3 = RigidTransform['rotation'];

const IDENTITY: RigidTransform = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] };

/** Placement of mesh j in the frame of mesh i: Ri^T Rj, Ri^T (tj - ti). */
function relativePlacement(a: RigidTransform | null, b: RigidTransform | null): RigidTransform | null {
  if (a === null && b === null) return null;
  const [ra, rb] = [(a ?? IDENTITY).rotation, (b ?? IDENTITY).rotation];
  const [ta, tb] = [(a ?? IDENTITY).translation, (b ?? IDENTITY).translation];
  const d: Vec3 = [tb[0] - ta[0], tb[1] - ta[1], tb[2] - ta[2]];
  const at = (m: Mat3, row: number, col: number): number => m[row * 3 + col] ?? 0;
  const rotation: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) rotation.push(at(ra, 0, r) * at(rb, 0, c) + at(ra, 1, r) * at(rb, 1, c) + at(ra, 2, r) * at(rb, 2, c));
  }
  const translation: Vec3 = [0, 1, 2].map((r) => at(ra, 0, r) * d[0] + at(ra, 1, r) * d[1] + at(ra, 2, r) * d[2]) as unknown as Vec3;
  return { rotation: rotation as unknown as Mat3, translation };
}

/** The TS engine: deterministic AABB trees (`meshBvh`) and brute-force segment/triangle tests. Always available, browser included. */
export const meshBvhEngine: GeometryQueryEngine = {
  provenance: { engine: 'meshBvh', device: 'cpu', deterministic: true },
  limits: { maxViewFactorFacets: 400, maxThicknessRays: 200_000 },
  minDistanceBatch(meshes, poses, pairs, maxDistance) {
    const trees = new Map<number, MeshBvh>();
    const treeOf = (index: number): MeshBvh => {
      let tree = trees.get(index);
      if (tree === undefined) {
        tree = buildMeshBvh(meshes[index] ?? { positions: [], indices: [] });
        trees.set(index, tree);
      }
      return tree;
    };
    return poses.map((pose) =>
      pairs.map(([i, j]) => bvhMinDistance(treeOf(i), treeOf(j), maxDistance, relativePlacement(pose[i] ?? null, pose[j] ?? null))),
    );
  },
  rayCastBatch(mesh, rays, maxT) {
    if (rays.length === 0) return [];
    const tree = buildMeshBvh(mesh);
    return rays.map((ray) => bvhRayCast(tree, ray.origin, ray.direction, maxT, ray.tMin ?? 0));
  },
  segmentOcclusionBatch(occluders, segments) {
    return segments.map((segment) =>
      occluders.some((corners, index) => !segment.skip.includes(index) && segmentHitsTriangle(segment.start, segment.end, corners)),
    );
  },
};

let installed: GeometryQueryEngine | null = null;

/** Install (or with null, remove) the process engine read by `defaultContext()`. Composition roots only. */
export function setGeometryQueryEngine(engine: GeometryQueryEngine | null): void {
  installed = engine;
}

/** The installed engine, or null (the default `meshBvhEngine` then applies through `resolveGeometryQueries`). */
export function getGeometryQueryEngine(): GeometryQueryEngine | null {
  return installed;
}

/** The engine a command should use: the context's, else the default TS engine. */
export function resolveGeometryQueries(engine: GeometryQueryEngine | null | undefined): GeometryQueryEngine {
  return engine ?? meshBvhEngine;
}
