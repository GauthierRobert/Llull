/**
 * First `value` seen for the current content `key`, so dependent memos keep their identity.
 * @invariant the render-time ref write is safe: a discarded render leaves a value equal by `key` (≤ 1 extra rebuild).
 */

import { useRef } from 'react';

export function useStableByKey<T>(value: T, key: string): T {
  const stable = useRef({ key, value });
  if (stable.current.key !== key) stable.current = { key, value };
  return stable.current.value;
}

/** `"x,y;x,y"`. */
export function pointsKey(points: ReadonlyArray<ReadonlyArray<number>>): string {
  return points.map((point) => point.join(',')).join(';');
}

/** Previous list while its items are the same objects in the same order. */
export function useStableList<T>(items: ReadonlyArray<T>): ReadonlyArray<T> {
  const stable = useRef(items);
  const previous = stable.current;
  const same = previous.length === items.length && previous.every((item, i) => item === items[i]);
  if (!same) stable.current = items;
  return stable.current;
}
