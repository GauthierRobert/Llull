/** @layer ui/viewport — candidate ranking shared by the 2D and 3D snappers. */

/** Distances closer than this are ties, broken by type priority. */
const TIE_EPSILON = 1e-10;

/**
 * The candidate nearest to the cursor within `tolerance`; candidates at (numerically) the same
 * distance are ranked by type priority (lower number wins), then by order.
 *
 * @pure
 * @failure no candidate within tolerance -> null
 */
export function nearestSnap<Type extends string, Candidate extends { readonly type: Type }>(
  candidates: ReadonlyArray<Candidate>,
  distanceTo: (candidate: Candidate) => number,
  tolerance: number,
  priority: Readonly<Record<Type, number>>,
): Candidate | null {
  let best: Candidate | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = distanceTo(candidate);
    if (!(distance <= tolerance)) continue;
    const closer = distance < bestDistance - TIE_EPSILON;
    const tiedWithHigherPriority =
      best !== null &&
      Math.abs(distance - bestDistance) <= TIE_EPSILON &&
      priority[candidate.type] < priority[best.type];
    if (closer || tiedWithHigherPriority) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
