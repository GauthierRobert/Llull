/**
 * Pair-result cache (TECHNICAL_SPEC 5.3 step 7, TR-ASC-10): the classification of a part pair keyed by shape hashes + relative placement +
 * tolerances. A host hands one in through `ExecutionContext.pairCache` (the server keeps it across runs); without one, a
 * `resolveMemo` of the context is used, else nothing persists (the run still reuses pairs through its own map).
 * @invariant a hit equals a recompute: the key holds every input of the classification (content hashes, relative placement, tolerances, kernel); never time
 * @invariant bounded: least recently used entries go first; no module singleton, the instance is owned by whoever creates it
 */

import { LruCache } from '../../lib/lruCache';
import type { PairClass } from './pairClassify';

/** The part of `ResolveMemo` (`commands/resolveMemo`) the cache needs. */
interface OnceMemo {
  once<T>(owner: object, tag: string, compute: () => T): T;
}

/** What one classification produced: a class, "no relation" (undefined) or "the kernel cannot tell" (null). */
export interface PairEntry {
  readonly pair: PairClass | null | undefined;
}

export interface PairCache {
  /** The entry of `key`, computing and keeping it on a miss. `hit` is true when `compute` did not run. */
  getOrCompute(key: string, compute: () => PairEntry): { readonly entry: PairEntry; readonly hit: boolean };
}

/** About 300 bytes an entry: 200,000 entries stay near the 64 MB of the spec. */
const DEFAULT_CAPACITY = 200_000;

export function createPairCache(capacity: number = DEFAULT_CAPACITY): PairCache {
  const entries = new LruCache<PairEntry>(capacity);
  return {
    getOrCompute(key, compute) {
      const known = entries.get(key);
      if (known !== undefined) return { entry: known, hit: true };
      const entry = compute();
      entries.set(key, entry);
      return { entry, hit: false };
    },
  };
}

/** The one `PairCache` a resolve memo keeps for `owner` (normally the kernel): a single memo entry, so a 20k-part check evicts nothing else. */
export function pairCacheOnMemo(memo: OnceMemo, owner: object): PairCache {
  return memo.once(owner, 'pairCache', () => createPairCache());
}
