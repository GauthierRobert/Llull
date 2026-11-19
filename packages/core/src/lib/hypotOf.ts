/**
 * `Math.hypot(...values)` without the argument-count limit (a spread throws RangeError above ~1.5e5 items, PERF1 row 12). The same
 * algorithm as V8's builtin (src/builtins/math.tq `MathHypot`): an infinite value wins over NaN, then NaN, then an all-zero list is 0;
 * otherwise a Kahan sum of squares normalized by the largest magnitude — bit-identical to `Math.hypot` (pinned by tests).
 */
export function hypotOf(values: Iterable<number>): number {
  const magnitudes: number[] = [];
  let sawNaN = false;
  let largest = 0;
  for (const value of values) {
    if (value !== value) {
      sawNaN = true;
      magnitudes.push(0);
      continue;
    }
    const magnitude = Math.abs(value);
    magnitudes.push(magnitude);
    if (magnitude > largest) largest = magnitude;
  }
  if (largest === Infinity) return Infinity;
  if (sawNaN) return NaN;
  if (largest === 0) return 0;
  let sum = 0;
  let compensation = 0;
  for (const magnitude of magnitudes) {
    const normalized = magnitude / largest;
    const summand = normalized * normalized - compensation;
    const preliminary = sum + summand;
    compensation = preliminary - sum - summand;
    sum = preliminary;
  }
  return Math.sqrt(sum) * largest;
}
