/**
 * Substeps of `check_motion_clearance` between two recorded samples, and their up-front distance batch (PERF1): after the sample batch
 * of `motionPrefetch`, the moments the sweep will probe INSIDE recorded steps go out as a second `placedDistanceBatch`, so a native
 * engine answers them instead of `meshBvh` one by one (three quarters of a run on mechanisms whose parts stay close).
 * @invariant the sweep's numbers do not change: it reads a prefetched substep exactly as it reads a prefetched sample (an unbounded closest
 *   pair filtered by the probe's bound), and a moment that was not prefetched is queried on meshBvh as before, so the choice of steps
 *   below only decides where the time is spent
 */

import type { BvhDistance, RigidTransform } from '@core/geometry/meshBvh';
import type { GeometryQueryEngine, PlacedDistanceQuery } from '@core/geometry/geometryQueries';
import type { MeshData } from '@core/model/types';

/** Most substeps between two recorded samples (pose interpolation against tunnelling). */
const MAX_SUBSTEPS = 16;

/** Travel of one pair over the recorded steps, cumulative from sample 0 (`prefix[k]` = samples 0..k). */
export interface PairTravel {
  /** Sum of both parts' absolute travel: sizes the substeps of one step. */
  readonly prefix: readonly number[];
  /** The smaller of that and the relative motion of the pair: proves a stretch clear. */
  readonly certified: readonly number[];
  /** Largest travel one substep may cover: half the thinnest side of the pair. */
  readonly limit: number;
}

/** Substeps of a recorded step of `travel`: enough for each to cover at most `limit`, at most MAX_SUBSTEPS. */
export const substepCount = (travel: number, limit: number): number => Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(travel / limit)));

/** Moment (sample index + fraction) of substep `k` of `substeps` after recorded sample `from`. */
export const substepMoment = (from: number, k: number, substeps: number): number => from + k / substeps;

/** The prefetched closest pair of pair `pair` at the fractional moment `u`; undefined when it was not prefetched. */
export type SubstepPrefetch = (pair: number, u: number) => BvhDistance | null | undefined;

export interface SubstepPrefetchInput {
  readonly engine: GeometryQueryEngine;
  readonly meshes: readonly MeshData[];
  readonly pairCount: number;
  /** Indices in `meshes` of the pair's two parts. */
  readonly meshesOf: (pair: number) => readonly [number, number];
  readonly sampleCount: number;
  readonly stride: number;
  /** The sweep's floor of the distance bound (clearance + touch tolerance). */
  readonly lowBound: number;
  /** The prefetched sample distance (`motionPrefetch`): undefined = that sample was not prefetched. */
  readonly sampleDistance: (pair: number, sample: number) => BvhDistance | null | undefined;
  readonly travelOf: (pair: number) => PairTravel;
  /** Placement of the pair's second mesh in the first one's frame at moment `u` (the sweep's `relativeTransform`). */
  readonly placementAt: (pair: number, u: number) => RigidTransform;
}

/**
 * The fractional moments pair `pair` can need, or null when one of its samples was not prefetched. A recorded step is substepped only
 * when the sweep cannot certify it clear: (d_from + d_to - travel) / 2 <= bound, where the probed distances are at least
 * min(d, bound) and the bound at that time is at most the smallest anchor distance seen so far (floored at `lowBound`). The left side
 * minus the bound never grows with the bound, so testing with that upper value keeps every step the sweep can reach.
 */
function momentsOf(input: SubstepPrefetchInput, pair: number): number[] | null {
  const { prefix, certified, limit } = input.travelOf(pair);
  const last = input.sampleCount - 1;
  const moments: number[] = [];
  const distanceAt = (sample: number): number | undefined => {
    const found = input.sampleDistance(pair, sample);
    return found === undefined ? undefined : found === null ? Infinity : found.distance;
  };
  let nearest = Infinity;
  for (let from = 0; from < last; from += Math.max(1, input.stride)) {
    const to = Math.min(from + Math.max(1, input.stride), last);
    const [atFrom, atTo] = [distanceAt(from), distanceAt(to)];
    if (atFrom === undefined || atTo === undefined) return null;
    nearest = Math.min(nearest, atFrom, atTo);
    const bound = Math.max(input.lowBound, nearest);
    for (let sample = from; sample < to; sample += 1) {
      const [here, next] = [distanceAt(sample), distanceAt(sample + 1)];
      if (here === undefined || next === undefined) return null;
      const travel = (certified[sample + 1] as number) - (certified[sample] as number);
      if ((Math.min(here, bound) + Math.min(next, bound) - travel) / 2 > bound) continue;
      const substeps = substepCount((prefix[sample + 1] as number) - (prefix[sample] as number), limit);
      for (let k = 1; k < substeps; k += 1) moments.push(substepMoment(sample, k, substeps));
    }
  }
  return moments;
}

/** Runs the batch; null when the engine does not prefetch, nothing is to substep, the batch is over the engine limit, or the engine fails or answers short. */
export function prefetchSubsteps(input: SubstepPrefetchInput): SubstepPrefetch | null {
  const limit = input.engine.limits.motionPrefetchQueries;
  if (limit <= 0) return null;
  const wanted: { readonly pair: number; readonly u: number }[] = [];
  for (let pair = 0; pair < input.pairCount; pair += 1) {
    for (const u of momentsOf(input, pair) ?? []) wanted.push({ pair, u });
    if (wanted.length > limit) return null;
  }
  if (wanted.length === 0) return null;
  const queries: PlacedDistanceQuery[] = wanted.map(({ pair, u }) => {
    const [a, b] = input.meshesOf(pair);
    return { a, b, placement: input.placementAt(pair, u), maxDistance: Infinity };
  });
  let results: (BvhDistance | null)[];
  try {
    results = input.engine.placedDistanceBatch(input.meshes, queries);
  } catch {
    return null;
  }
  if (results.length !== queries.length) return null;
  const byPair = new Map<number, Map<number, BvhDistance | null>>();
  wanted.forEach(({ pair, u }, index) => {
    let moments = byPair.get(pair);
    if (moments === undefined) byPair.set(pair, (moments = new Map()));
    moments.set(u, results[index] ?? null);
  });
  return (pair, u) => byPair.get(pair)?.get(u);
}
