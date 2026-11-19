/**
 * Reference exchange matrix of `compute_view_factors` (PHY-03 TR-THM-20, TECHNICAL_SPEC 5.4): used when the engine has no native
 * `viewFactorExchange`, and the oracle of `llull-compute geomq` (VC-THM-64). Obstruction goes through the engine's `segmentOcclusionBatch`.
 * @invariant `full`: pairs are visited emitting facet first (surface-major order), receiving facet second; each A_I F_IJ sums in that order
 * @invariant `reciprocal`: unordered pairs (i, j > i) in that order; ONE value per pair (`reciprocalExchangeArea(i, j)`) is added to [I][J]
 *   when i -> j is unobstructed and to [J][I] when j -> i is, so both directions keep the obstruction answer `full` gives them
 * @invariant obstruction tests the open segment between the two centroids against every facet (surfaces, then blockers) but the pair's own two
 */

import type { GeometryQueryEngine, OcclusionSegment, ViewFactorExchangeOptions } from '@core/geometry/geometryQueries';
import { type Facet, exchangeArea, facing, reciprocalExchangeArea } from './viewFactorContour';

interface Owner {
  readonly facet: Facet;
  readonly surface: number;
}

const occluders = (owners: readonly Owner[], blockers: readonly Facet[]): Facet['corners'][] => [
  ...owners.map((owner) => owner.facet.corners),
  ...blockers.map((f) => f.corners),
];

function fullExchange(engine: GeometryQueryEngine, owners: readonly Owner[], blockers: readonly Facet[] | null, count: number): number[][] {
  const candidates = owners.flatMap((a, i) =>
    owners.flatMap((b, j) => (a.surface !== b.surface && facing(a.facet, b.facet) ? [{ a, b, skip: [i, j] }] : [])),
  );
  const segments: OcclusionSegment[] =
    blockers === null ? [] : candidates.map(({ a, b, skip }) => ({ start: a.facet.centroid, end: b.facet.centroid, skip }));
  const blocked = blockers === null ? [] : engine.segmentOcclusionBatch(occluders(owners, blockers), segments);
  const exchange = Array.from({ length: count }, () => new Array<number>(count).fill(0));
  candidates.forEach(({ a, b }, k) => {
    if (blocked[k] === true) return;
    const row = exchange[a.surface];
    if (row !== undefined) row[b.surface] = (row[b.surface] ?? 0) + exchangeArea(a.facet, b.facet);
  });
  return exchange;
}

function reciprocalExchange(
  engine: GeometryQueryEngine,
  owners: readonly Owner[],
  blockers: readonly Facet[] | null,
  count: number,
): number[][] {
  const candidates = owners.flatMap((a, i) =>
    owners
      .slice(i + 1)
      .flatMap((b, offset) => (a.surface !== b.surface && facing(a.facet, b.facet) ? [{ a, b, i, j: i + 1 + offset }] : [])),
  );
  const segments: OcclusionSegment[] =
    blockers === null
      ? []
      : candidates.flatMap(({ a, b, i, j }) => [
          { start: a.facet.centroid, end: b.facet.centroid, skip: [i, j] },
          { start: b.facet.centroid, end: a.facet.centroid, skip: [j, i] },
        ]);
  const blocked = blockers === null ? [] : engine.segmentOcclusionBatch(occluders(owners, blockers), segments);
  const exchange = Array.from({ length: count }, () => new Array<number>(count).fill(0));
  const add = (from: number, to: number, value: number): void => {
    const row = exchange[from];
    if (row !== undefined) row[to] = (row[to] ?? 0) + value;
  };
  candidates.forEach(({ a, b }, k) => {
    const forward = blocked[2 * k] !== true;
    const backward = blocked[2 * k + 1] !== true;
    if (!forward && !backward) return;
    const value = reciprocalExchangeArea(a.facet, b.facet);
    if (forward) add(a.surface, b.surface, value);
    if (backward) add(b.surface, a.surface, value);
  });
  return exchange;
}

/** A_I F_IJ between the facet groups `surfaces`; `blockers` non-null = obstruction on (blockers shadow, never radiate). */
export function viewFactorExchangeReference(
  engine: GeometryQueryEngine,
  surfaces: readonly (readonly Facet[])[],
  blockers: readonly Facet[] | null,
  options: ViewFactorExchangeOptions = {},
): number[][] {
  const owners = surfaces.flatMap((facets, surface) => facets.map((facet): Owner => ({ facet, surface })));
  return options.integration === 'reciprocal'
    ? reciprocalExchange(engine, owners, blockers, surfaces.length)
    : fullExchange(engine, owners, blockers, surfaces.length);
}
