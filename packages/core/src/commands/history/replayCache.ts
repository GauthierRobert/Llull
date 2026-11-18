/**
 * Replay prefix cache: the document state after each replayed step, keyed by a hash of
 * everything that determines it (initial state + every step's name, id and resolved params up to
 * that point). Editing step k or a parameter used only from step k on re-runs steps k..n only.
 *
 *   (commands are pure, ids are step-scoped, the kernel is memoized and deterministic)
 */

import type { CadDocument } from '../../model/types';
import { hashText } from '../../lib/hash';
import { LruCache } from '../../lib/lruCache';

interface ReplayState {
  readonly doc: CadDocument;
  /** Legacy (pre-step-scoped) id remapping accumulated up to this state. */
  readonly idMap: ReadonlyMap<string, string>;
  /** The step leading to this state changed nothing (it threw, was rejected, or was a no-op). */
  readonly inert: boolean;
  /** Why the step leading to this state failed (threw, was rejected, or reported a failed plan); absent when it succeeded. */
  readonly failure?: string;
  /**
   * Present only when the step's `run` read `doc.parameters`: the fingerprint of the table it ran against (the entry is served only for the
   * same table). Absent ⇒ parameter-independent: served for any table, which the replay restores onto the state.
   */
  readonly parameterFingerprint?: string;
}

export type ReplayCache = LruCache<ReplayState>;

/** Key of the state after applying a step with `resolvedParams` to the state keyed `previous`. */
export function nextStateKey(previous: string, stepId: string, commandName: string, resolvedParams: unknown): string {
  return hashText(`${previous}|${stepId}|${commandName}|${JSON.stringify(resolvedParams) ?? ''}`);
}

/**
 * Capacity 1024: one replay inserts one entry per live step and reads them in order, so an LRU smaller than the history evicts exactly the
 * prefix the next replay needs (every edit misses). States share structure (spread documents): each holds its own entities record (pointers only), so memory grows with steps × entities.
 */
export function createReplayCache(capacity = 1024): ReplayCache {
  return new LruCache(capacity);
}

/** Heap a cached state costs per entity it references (its own entities record: measured ~200 bytes per entry at 2 000 x 2 000). */
const BYTES_PER_STATE_ENTITY = 200;
/** Ceiling of the heap one history's states may take. */
const REPLAY_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * The cache a replay of `liveSteps` steps over a document of `entityCount` entities should use: `cache` grown to hold the whole
 * history (a smaller LRU evicts exactly the prefix the next replay needs, so every edit would miss), or null when those states
 * would not fit the budget (a history too large to memoize replays faster uncached than under the collector's pressure).
 */
export function replayCacheFor(cache: ReplayCache | null, liveSteps: number, entityCount: number): ReplayCache | null {
  if (cache === null) return null;
  // A parameter-dependent step stores a second entry (its per-table variant): room for both.
  const wanted = 2 * liveSteps + 16;
  if (wanted <= cache.capacityNow) return cache;
  // States grow from empty to the full document: half the entities on average.
  if ((liveSteps * entityCount * BYTES_PER_STATE_ENTITY) / 2 > REPLAY_CACHE_BUDGET_BYTES) return null;
  cache.ensureCapacity(wanted);
  return cache;
}
