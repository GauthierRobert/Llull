/**
 * `compute` cached per key object, held weakly: for data derived from an immutable value (a stored artifact, a document part).
 * The cached result is shared by every caller, so it must be treated as read-only.
 */
export function memoByObject<K extends object, V>(compute: (key: K) => V): (key: K) => V {
  const known = new WeakMap<K, { readonly value: V }>();
  return (key) => {
    const hit = known.get(key);
    if (hit !== undefined) return hit.value;
    const value = compute(key);
    known.set(key, { value });
    return value;
  };
}
