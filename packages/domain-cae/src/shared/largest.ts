/** Largest of `values`, or `floor` when there are none or all are smaller. A loop: `Math.max(...array)` throws a RangeError above ~1.5e5 items. */
export function largest(values: Iterable<number>, floor = 0): number {
  let best = floor;
  for (const value of values) if (value > best) best = value;
  return best;
}
