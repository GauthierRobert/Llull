/**
 * Linear `Math.max(...values)` / `Math.min(...values)`: a spread passes every element as a call argument and throws RangeError above
 * ~1.5e5 items (PERF1 row 12). Same results as the built-ins: empty ⇒ -Infinity / +Infinity, any NaN ⇒ NaN, +0 ranks above -0, and
 * every item gets one ToNumber, in order, even after a NaN (`spreadArguments.ts`).
 */
import { spreadSource, toNumbersFrom } from './spreadArguments';

const larger = (result: number, value: number): number =>
  value !== value ? NaN : value > result || (value === 0 && result === 0 && 1 / value > 0) ? value : result;

const smaller = (result: number, value: number): number =>
  value !== value ? NaN : value < result || (value === 0 && result === 0 && 1 / value < 0) ? value : result;

function fold(values: Iterable<number>, initial: number, step: (result: number, value: number) => number): number {
  const items = spreadSource(values);
  let result = initial;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item !== 'number') {
      for (const value of toNumbersFrom(items, i)) result = step(result, value);
      return result;
    }
    result = step(result, item);
  }
  return result;
}

/** `Math.max(...values)` without the argument-count limit. */
export function maxOf(values: Iterable<number>): number {
  return fold(values, -Infinity, larger);
}

/** `Math.min(...values)` without the argument-count limit. */
export function minOf(values: Iterable<number>): number {
  return fold(values, Infinity, smaller);
}
