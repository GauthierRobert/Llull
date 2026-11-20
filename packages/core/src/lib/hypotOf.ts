/**
 * `Math.hypot(...values)` without the argument-count limit (a spread throws RangeError above ~1.5e5 items, PERF1 row 12). The same
 * algorithm as V8's builtin (src/builtins/math.tq `MathHypot`): every item gets one ToNumber, in order (`spreadArguments.ts`); then
 * an infinite value wins over NaN, then NaN, then an all-zero list is 0; otherwise a Kahan sum of squares normalized by the largest
 * magnitude — bit-identical to `Math.hypot` (pinned by tests).
 */
import { spreadSource, toNumbersFrom } from './spreadArguments';

function magnitudesOf(values: Iterable<number>): number[] {
  const items = spreadSource(values);
  const magnitudes: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item !== 'number') {
      for (const value of toNumbersFrom(items, i)) magnitudes.push(Math.abs(value));
      return magnitudes;
    }
    magnitudes.push(Math.abs(item));
  }
  return magnitudes;
}

export function hypotOf(values: Iterable<number>): number {
  const magnitudes = magnitudesOf(values);
  let sawNaN = false;
  let largest = 0;
  for (const magnitude of magnitudes) {
    if (magnitude !== magnitude) sawNaN = true;
    else if (magnitude > largest) largest = magnitude;
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
