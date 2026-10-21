/** Caller-chosen ids: an explicit non-empty id, else a freshly minted one. */

import { nextId } from './id';

/** The explicit `id` when non-empty, else a fresh `prefix` id. */
export function idOrNext(id: string | undefined, prefix: string): string {
  return id !== undefined && id.length > 0 ? id : nextId(prefix);
}

/** True when `id` is an own key of `bag` (prototype keys such as "constructor" do not count). */
export function idTaken(bag: Readonly<Record<string, unknown>>, id: string): boolean {
  return Object.hasOwn(bag, id);
}
