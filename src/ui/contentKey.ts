/**
 * React key for a form seeded from an immutable document object: its content hash, so the
 * form remounts (re-seeds its draft) exactly when the object's content changes — undo, live sync,
 * an agent edit — and keeps its draft otherwise. The hash is computed once per object identity.
 */

import { hashText } from '@lib/hash';

const hashes = new WeakMap<object, string>();

export function contentKey(item: object): string {
  let hash = hashes.get(item);
  if (hash === undefined) {
    hash = hashText(JSON.stringify(item));
    hashes.set(item, hash);
  }
  return hash;
}
