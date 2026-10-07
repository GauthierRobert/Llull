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
