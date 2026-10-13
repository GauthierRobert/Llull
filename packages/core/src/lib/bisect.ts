/**
 * Interval halving on a monotone predicate: each step moves `low` to the midpoint when `isBelow(midpoint)` holds, else moves `high` to it.
 * Returns the final bracket so callers pick the end (or midpoint) their contract needs.
 */
export function bisect(
  isBelow: (value: number) => boolean,
  low: number,
  high: number,
  steps = 60,
): { readonly low: number; readonly high: number } {
  let [lo, hi] = [low, high];
  for (let step = 0; step < steps; step += 1) {
    const middle = (lo + hi) / 2;
    if (isBelow(middle)) lo = middle;
    else hi = middle;
  }
  return { low: lo, high: hi };
}
