/**
 * @layer ui/viewport
 * Returns the first `value` seen for the current `key`; a new object with an unchanged content
 * `key` keeps the previous identity, so memos depending on it do not recompute.
 * @invariant the render-time ref write is safe: a discarded render leaves only a value equal by
 *            `key`, costing at most one extra rebuild.
 */

import { useRef } from 'react';

export function useStableByKey<T>(value: T, key: string): T {
  const stable = useRef({ key, value });
  if (stable.current.key !== key) stable.current = { key, value };
  return stable.current.value;
}

/** Content key of a point list (`"x,y;x,y"`), for `useStableByKey`. */
export function pointsKey(points: ReadonlyArray<ReadonlyArray<number>>): string {
  return points.map((point) => point.join(',')).join(';');
}

/** Returns the previous list while its items are the same objects in the same order. */
export function useStableList<T>(items: ReadonlyArray<T>): ReadonlyArray<T> {
  const stable = useRef(items);
  const previous = stable.current;
  const same = previous.length === items.length && previous.every((item, i) => item === items[i]);
  if (!same) stable.current = items;
  return stable.current;
}
