/**
 * Resolve-scoped memo (07 MSH TECHNICAL_SPEC 13.9). The host runs a command that may need a native mesh job several times (13.8): every run redoes the
 * plan steps before the job and the command's own preparation of its mesh. A memo handed through `ExecutionContext.resolveMemo` lets those runs share
 * what is a pure function of an object they all see: the document a step starts from, the entity a command loads.
 * @invariant a value is stored under (owner object identity, tag) only: a new document or entity object is a miss, never a stale hit
 * @invariant nothing is stored once an engine deferred an answer in the current run (`beginRun`): from there on a run works on placeholders
 * @invariant bounded: at most `maxEntries` entries and `maxWeight` weight; beyond that a value is computed but not kept (the earliest entries stay, which is the prefix the next run reads first)
 * @invariant `dispose` drops everything; a disposed memo computes without keeping
 */

import { deferralCount } from '../geometry/mesh/engine';

/** Entries one resolve keeps (a plan step is one entry). */
const DEFAULT_MAX_ENTRIES = 1024;
/** Weight one resolve keeps: about the number of numbers held (a 330k-triangle mesh is about 1.5 million), roughly 250 MB of arrays. */
const DEFAULT_MAX_WEIGHT = 32_000_000;

export interface ResolveMemo {
  /**
   * The value of `compute` for (`owner`, `tag`): computed on the first call, then served while the memo lives. A throw is not kept.
   * `weight` is the size of the value in numbers (default 1; a function of the value) against the memo's budget.
   */
  once<T>(owner: object, tag: string, compute: () => T, weight?: number | ((value: T) => number)): T;
  /** A new run of the resolved command begins: engine answers deferred before this point no longer count against what the run computes. */
  beginRun(): void;
  /** Drop every entry; the memo keeps nothing afterwards. */
  dispose(): void;
  /** Entries and weight held now. */
  readonly size: number;
  readonly weight: number;
}

export interface ResolveMemoLimits {
  readonly maxEntries?: number;
  readonly maxWeight?: number;
}

export function createResolveMemo(limits: ResolveMemoLimits = {}): ResolveMemo {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxWeight = limits.maxWeight ?? DEFAULT_MAX_WEIGHT;
  let owners = new WeakMap<object, Map<string, unknown>>();
  let entries = 0;
  let held = 0;
  let disposed = false;
  let baseline = deferralCount();
  return {
    once<T>(owner: object, tag: string, compute: () => T, weight: number | ((value: T) => number) = 1): T {
      const known = owners.get(owner);
      if (known?.has(tag) === true) return known.get(tag) as T;
      const value = compute();
      const size = typeof weight === 'function' ? weight(value) : weight;
      if (disposed || deferralCount() !== baseline || entries >= maxEntries || held + size > maxWeight) return value;
      // re-read: `compute` may have stored values under the same owner itself
      const table = owners.get(owner) ?? new Map<string, unknown>();
      owners.set(owner, table);
      table.set(tag, value);
      entries += 1;
      held += size;
      return value;
    },
    beginRun(): void {
      baseline = deferralCount();
    },
    dispose(): void {
      disposed = true;
      owners = new WeakMap();
      entries = 0;
      held = 0;
    },
    get size(): number {
      return entries;
    },
    get weight(): number {
      return held;
    },
  };
}
