/**
 * Reference exchange matrix of `compute_view_factors` (PHY-03 TR-THM-20, TECHNICAL_SPEC 5.4): used when the engine has no native
 * `viewFactorExchange`, and the oracle of `llull-compute geomq` (VC-THM-64). Obstruction goes through the engine's `segmentOcclusionBatch`.
 * @invariant pairs are visited emitting facet first (surface-major order), receiving facet second; each A_I F_IJ sums in that order
 * @invariant obstruction tests the open segment between the two centroids against every facet (surfaces, then blockers) but the pair's own two
 */

import type { GeometryQueryEngine, OcclusionSegment } from '@core/geometry/geometryQueries';
import { type Facet, exchangeArea, facing } from './viewFactorContour';

/** A_I F_IJ between the facet groups `surfaces`; `blockers` non-null = obstruction on (blockers shadow, never radiate). */
export function viewFactorExchangeReference(
  engine: GeometryQueryEngine,
  surfaces: readonly (readonly Facet[])[],
  blockers: readonly Facet[] | null,
): number[][] {
  const owners = surfaces.flatMap((facets, surface) => facets.map((facet) => ({ facet, surface })));
  const candidates = owners.flatMap((a, i) =>
    owners.flatMap((b, j) => (a.surface !== b.surface && facing(a.facet, b.facet) ? [{ a, b, skip: [i, j] }] : [])),
  );
  const segments: OcclusionSegment[] =
    blockers === null ? [] : candidates.map(({ a, b, skip }) => ({ start: a.facet.centroid, end: b.facet.centroid, skip }));
  const blocked =
    blockers === null
      ? []
      : engine.segmentOcclusionBatch([...owners.map((owner) => owner.facet.corners), ...blockers.map((f) => f.corners)], segments);
  const exchange = surfaces.map(() => new Array<number>(surfaces.length).fill(0));
  candidates.forEach(({ a, b }, k) => {
    if (blocked[k] === true) return;
    const row = exchange[a.surface];
    if (row !== undefined) row[b.surface] = (row[b.surface] ?? 0) + exchangeArea(a.facet, b.facet);
  });
  return exchange;
}
