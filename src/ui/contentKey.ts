// React key of a form seeded from an immutable document object: its content hash (once per identity), so the form
// re-seeds exactly when the content changes (undo, live sync, an agent edit).

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
