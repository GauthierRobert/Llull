/**
 * `target.splice(start, deleteCount, ...items)` without the argument-count limit (a spread throws RangeError above ~1.5e5 items,
 * PERF1 row 12). Same semantics as the built-in for an ordinary array: `start` / `deleteCount` go through ToIntegerOrInfinity and are
 * clamped (a negative start counts from the end), the items are read in full before the array changes (as the spread is, so splicing
 * an array into itself works), holes in the moved tail stay holes, and the removed elements come back as a new array.
 */

const toIntegerOrInfinity = (value: number): number => {
  const integer = Math.trunc(value);
  return integer !== integer ? 0 : integer + 0;
};

export function spliceAll<T>(target: T[], start: number, deleteCount: number, items: Iterable<NoInfer<T>>): T[] {
  const inserted = Array.from(items);
  const length = target.length;
  const relativeStart = toIntegerOrInfinity(start);
  const actualStart = relativeStart < 0 ? Math.max(length + relativeStart, 0) : Math.min(relativeStart, length);
  const actualDelete = Math.min(Math.max(toIntegerOrInfinity(deleteCount), 0), length - actualStart);
  const removed = target.slice(actualStart, actualStart + actualDelete);
  const tail = target.slice(actualStart + actualDelete);
  target.length = actualStart;
  for (const item of inserted) target.push(item);
  const tailStart = target.length;
  for (let i = 0; i < tail.length; i++) if (i in tail) target[tailStart + i] = tail[i] as T;
  target.length = tailStart + tail.length;
  return removed;
}
