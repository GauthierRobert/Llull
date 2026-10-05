/**
 * Replay prefix cache: the document state after each replayed step, keyed by a hash of
 * everything that determines it (initial state + every step's name, id and resolved params up to
 * that point). Editing step k or a parameter used only from step k on re-runs steps k..n only.
 *
 * @layer core/commands
 * @pure semantically transparent: a hit returns exactly what re-running the prefix would produce
 *   (commands are pure, ids are step-scoped, the kernel is memoized and deterministic)
 * @invariant a step that mints a globally unique id (`uniqueId`, e.g. the building uid) is never
 *   memoized; replayHistory folds that id into the key of every later state
 */

import type { CadDocument } from '../model/types';
import { hashText } from '../lib/hash';
import { LruCache } from '../lib/lruCache';

interface ReplayState {
  readonly doc: CadDocument;
  /** Legacy (pre-step-scoped) id remapping accumulated up to this state. */
  readonly idMap: ReadonlyMap<string, string>;
}

export type ReplayCache = LruCache<ReplayState>;

/** Key of the state after applying a step with `resolvedParams` to the state keyed `previous`. */
export function nextStateKey(
  previous: string,
  stepId: string,
  commandName: string,
  resolvedParams: unknown,
): string {
  return hashText(`${previous}|${stepId}|${commandName}|${JSON.stringify(resolvedParams) ?? ''}`);
}

export function createReplayCache(capacity = 256): ReplayCache {
  return new LruCache(capacity);
}
