/**
 * Replay prefix cache (MG4.3): the document state after each replayed step, keyed by a hash of
 * everything that determines it (initial state + every step's name, id and resolved params up to
 * that point). Editing step k or a parameter used only from step k on re-runs steps k..n only.
 *
 * @layer core/commands
 * @pure semantically transparent: a hit returns exactly what re-running the prefix would produce
 *   (commands are pure, ids are step-scoped, the kernel is memoized and deterministic)
 */

import type { CadDocument } from '../model/types';
import { hashText } from '../../lib/hash';

export interface ReplayState {
  readonly doc: CadDocument;
  /** Legacy (pre-step-scoped) id remapping accumulated up to this state. */
  readonly idMap: ReadonlyMap<string, string>;
}

export interface ReplayCache {
  get(key: string): ReplayState | undefined;
  set(key: string, state: ReplayState): void;
  readonly size: number;
}

/** Key of the state after applying a step with `resolvedParams` to the state keyed `previous`. */
export function nextStateKey(
  previous: string,
  stepId: string,
  commandName: string,
  resolvedParams: unknown,
): string {
  return hashText(`${previous}|${stepId}|${commandName}|${JSON.stringify(resolvedParams) ?? ''}`);
}

export function createReplayCache(capacity = 512): ReplayCache {
  const entries = new Map<string, ReplayState>();
  return {
    get(key) {
      const state = entries.get(key);
      if (state !== undefined) {
        entries.delete(key);
        entries.set(key, state);
      }
      return state;
    },
    set(key, state) {
      entries.delete(key);
      entries.set(key, state);
      if (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
