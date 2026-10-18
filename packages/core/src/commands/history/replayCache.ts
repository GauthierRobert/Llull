/**
 * Replay prefix cache: the document state after each replayed step, keyed by a hash of
 * everything that determines it (initial state + every step's name, id and resolved params up to
 * that point). Editing step k or a parameter used only from step k on re-runs steps k..n only.
 *
 *   (commands are pure, ids are step-scoped, the kernel is memoized and deterministic)
 * @invariant a step that mints a globally unique id (`uniqueId`, e.g. the building uid) is never
 *   memoized; replayHistory folds that id into the key of every later state
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
 * prefix the next replay needs (every edit misses). States share structure (spread documents), so 1024 stay in the low MBs.
 */
export function createReplayCache(capacity = 1024): ReplayCache {
  return new LruCache(capacity);
}
