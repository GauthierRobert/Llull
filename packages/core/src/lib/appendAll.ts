import { spreadSource } from './spreadArguments';

/**
 * `target.push(...source)` without the argument-count limit (a spread throws RangeError above ~1.5e5 items, PERF1 row 12): appends
 * every item in order, one push each, and returns the new length. The source is read in full first, as a spread is, so appending an
 * array (or an iterator over it) to itself doubles it once.
 */
export function appendAll<T>(target: T[], source: Iterable<NoInfer<T>>): number {
  const items = spreadSource(source) as ArrayLike<T>;
  const count = items.length;
  for (let i = 0; i < count; i++) target.push(items[i] as T);
  return target.length;
}
