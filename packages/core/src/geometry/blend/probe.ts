/**
 * Largest radius that builds, by bisection on exact evaluations (BLD M0 `probe_fillet`, TECHNICAL_SPEC §4): the caller supplies `builds(r)`
 * (a cached kernel evaluation); this module only searches.
 * @invariant pure; assumes feasibility is monotone in the radius (builds below a limit, refused above); at most `maxEvaluations` calls
 */

export interface ProbeOutcome {
  /** Largest radius known to build (0 when even the smallest probed radius is refused). */
  readonly maxRadius: number;
  /** Smallest radius known to be refused; absent when `upper` itself builds. */
  readonly refusedAt?: number;
  readonly evaluations: number;
}

/**
 * Starts at `upper` (a guess of the limit): when it builds the search grows by doubling up to `cap` until a radius is refused, then bisects.
 * @failure upper <= 0, tolerance <= 0 or maxEvaluations < 1 -> maxRadius 0 with no evaluation
 */
export function bisectLargestRadius(
  builds: (radius: number) => boolean,
  upper: number,
  tolerance: number,
  maxEvaluations: number,
  cap: number = upper,
): ProbeOutcome {
  if (!(upper > 0) || !(tolerance > 0) || maxEvaluations < 1) return { maxRadius: 0, evaluations: 0 };
  let evaluations = 1;
  let low = 0;
  let high = upper;
  if (builds(upper)) {
    low = upper;
    high = Math.min(cap, 2 * upper);
    if (!(high > low)) return { maxRadius: low, evaluations };
    for (;;) {
      if (evaluations >= maxEvaluations) return { maxRadius: low, evaluations };
      evaluations++;
      if (!builds(high)) break;
      low = high;
      if (high >= cap) return { maxRadius: low, evaluations };
      high = Math.min(cap, 2 * high);
    }
  }
  while (evaluations < maxEvaluations && high - low > tolerance) {
    const middle = (low + high) / 2;
    evaluations++;
    if (builds(middle)) low = middle;
    else high = middle;
  }
  return { maxRadius: low, refusedAt: high, evaluations };
}
