/**
 * Linear `Math.max(...values)` / `Math.min(...values)`: a spread passes every element as a call argument and throws RangeError above
 * ~1.5e5 items (PERF1 row 12). Same results as the built-ins: empty ⇒ -Infinity / +Infinity, any NaN ⇒ NaN, +0 ranks above -0.
 */

/** `Math.max(...values)` without the argument-count limit. */
export function maxOf(values: Iterable<number>): number {
  let result = -Infinity;
  let sawNaN = false;
  for (const value of values) {
    if (value > result || (value === 0 && result === 0 && 1 / value > 0)) result = value;
    else if (value !== value) sawNaN = true;
  }
  return sawNaN ? NaN : result;
}

/** `Math.min(...values)` without the argument-count limit. */
export function minOf(values: Iterable<number>): number {
  let result = Infinity;
  let sawNaN = false;
  for (const value of values) {
    if (value < result || (value === 0 && result === 0 && 1 / value < 0)) result = value;
    else if (value !== value) sawNaN = true;
  }
  return sawNaN ? NaN : result;
}
