/**
 * Up-front distance batch of `check_motion_clearance` (PHY-21 TR-FPR-10 / TR-FPR-19, RS1 RS-6): when the engine allows it
 * (`limits.motionPrefetchQueries`, 0 on the TS engine), the pair distances at every recorded sample (else at the coarse anchors) go out as
 * one `placedDistanceBatch` with no distance bound, and the sequential sweep reads them instead of querying `meshBvh` there.
 * @invariant the sweep's numbers do not change: an unbounded closest pair, filtered by the probe's bound, is what the bounded query returns
 *   (same minimum, same first witness in traversal order: the order does not depend on the bound), up to node-box rounding when the bound
 *   equals the distance to the last ulp; fractional moments (substeps, bisection, golden search) stay on meshBvh
 */

import type { MeshData } from '@core/model/types';
import type { BvhDistance, RigidTransform } from '@core/geometry/meshBvh';
import type { GeometryQueryEngine, PlacedDistanceQuery } from '@core/geometry/geometryQueries';

/** The prefetched closest pair of pair `pair` at recorded sample `sample`; undefined when it was not prefetched. */
export type MotionPrefetch = (pair: number, sample: number) => BvhDistance | null | undefined;

export interface MotionPrefetchInput<P> {
  readonly engine: GeometryQueryEngine;
  readonly meshes: readonly MeshData[];
  /** Every swept pair, in sweep order. */
  readonly pairs: readonly P[];
  /** Indices in `meshes` of the pair's two parts. */
  readonly meshesOf: (pair: P) => readonly [number, number];
  readonly sampleCount: number;
  readonly stride: number;
  /** Placement of the pair's second mesh in the first one's frame at a recorded sample (the sweep's `relativeTransform`). */
  readonly placementAt: (pair: P, sample: number) => RigidTransform;
}

/** The samples to prefetch: all of them when the product fits the engine limit, else the anchors, else none. */
function samplesToPrefetch(limit: number, pairCount: number, sampleCount: number, stride: number): number[] {
  if (limit <= 0 || pairCount === 0 || sampleCount === 0) return [];
  if (pairCount * sampleCount <= limit) return Array.from({ length: sampleCount }, (_, s) => s);
  const last = sampleCount - 1;
  const anchors: number[] = [];
  for (let s = 0; s < last; s += Math.max(1, stride)) anchors.push(s);
  anchors.push(last);
  return pairCount * anchors.length <= limit ? anchors : [];
}

/** Runs the batch; null when the engine does not prefetch, the run is over its limit even at the anchors, or the engine fails or answers short. */
export function prefetchMotion<P>(input: MotionPrefetchInput<P>): MotionPrefetch | null {
  const samples = samplesToPrefetch(input.engine.limits.motionPrefetchQueries, input.pairs.length, input.sampleCount, input.stride);
  if (samples.length === 0) return null;
  const queries: PlacedDistanceQuery[] = input.pairs.flatMap((pair) => {
    const [a, b] = input.meshesOf(pair);
    return samples.map((sample) => ({ a, b, placement: input.placementAt(pair, sample), maxDistance: Infinity }));
  });
  let results: (BvhDistance | null)[];
  try {
    results = input.engine.placedDistanceBatch(input.meshes, queries);
  } catch {
    // the engine could not answer (a failed native run too large for its TS fallback): the sweep queries meshBvh itself
    return null;
  }
  if (results.length !== queries.length) return null;
  const slot = new Map(samples.map((sample, k) => [sample, k]));
  return (pair, sample) => {
    const k = slot.get(sample);
    return k === undefined ? undefined : results[pair * samples.length + k];
  };
}
