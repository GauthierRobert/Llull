/**
 * Refinement of the check_motion_clearance sweep (TECHNICAL_SPEC 5.6 step 4): contact-interval edges are bisected and the closest
 * approach of a pair is refined by a golden-section search, both on the run parameter `u` (sample index plus fraction).
 * @invariant deterministic (fixed iteration counts); the refined values never move outside the bracket they were given
 */

/** Edge tolerance in samples: an interval edge is located to 1e-3 of the sample spacing. */
export const EDGE_TOLERANCE = 1e-3;
/** Closest-approach tolerance in samples. */
const MINIMUM_TOLERANCE = 1e-4;
const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * The boundary between `outside` (no contact) and `inside` (contact), returned on the contact side, within `tolerance`.
 * @invariant the result lies between the two arguments and `inContact(result)` held when it was last probed (or it is `inside`)
 */
export function bisectEdge(inContact: (u: number) => boolean, outside: number, inside: number, tolerance = EDGE_TOLERANCE): number {
  let [free, hit] = [outside, inside];
  while (Math.abs(hit - free) > tolerance) {
    const middle = (free + hit) / 2;
    if (inContact(middle)) hit = middle;
    else free = middle;
  }
  return hit;
}

/** Golden-section minimum of `distance` on [low, high]; `start` is the best known point, kept unless the search finds a smaller value. */
export function goldenMinimum(
  distance: (u: number) => number,
  low: number,
  high: number,
  start: { readonly u: number; readonly value: number },
  tolerance = MINIMUM_TOLERANCE,
): { u: number; value: number } {
  let [a, b] = [low, high];
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let [fc, fd] = [distance(c), distance(d)];
  while (b - a > tolerance) {
    if (fc <= fd) {
      [b, d, fd] = [d, c, fc];
      c = b - GOLDEN * (b - a);
      fc = distance(c);
    } else {
      [a, c, fc] = [c, d, fd];
      d = a + GOLDEN * (b - a);
      fd = distance(d);
    }
  }
  const found = fc <= fd ? { u: c, value: fc } : { u: d, value: fd };
  return found.value < start.value ? found : { u: start.u, value: start.value };
}
