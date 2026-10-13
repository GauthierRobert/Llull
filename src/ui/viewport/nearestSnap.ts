/** Closer distances tie, broken by type priority. */
const TIE_EPSILON = 1e-10;

/** Nearest within `tolerance`; ties go to the lower type priority, then order. @failure none in tolerance -> null */
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
      best !== null && Math.abs(distance - bestDistance) <= TIE_EPSILON && priority[candidate.type] < priority[best.type];
    if (closer || tiedWithHigherPriority) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
