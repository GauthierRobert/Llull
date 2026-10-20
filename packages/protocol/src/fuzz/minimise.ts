/**
 * Delta debugging (Zeller's ddmin) of a fuzz step list: the smallest subsequence (in order) that still fails, the first item (the base
 * step) always kept. 1-minimal: removing any single remaining step makes the failure go away.
 */

import { runFuzzSteps } from './runner';
import type { FuzzCase, FuzzFailure, FuzzStep } from './types';

/** Split `items` into `n` contiguous, nearly equal, non-empty chunks. */
function chunks<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  const size = items.length / n;
  for (let k = 0; k < n; k++) out.push(items.slice(Math.round(k * size), Math.round((k + 1) * size)));
  return out.filter((chunk) => chunk.length > 0);
}

/**
 * Minimal failing subsequence of `items` (first kept). `fails` must hold for `items`; results are cached per subset so each subset runs
 * once. Returns `{ items, tests }` (tests = distinct predicate calls).
 */
export function minimiseList<T>(items: readonly T[], fails: (subset: readonly T[]) => boolean): { items: T[]; tests: number } {
  const [first, ...rest] = items;
  if (first === undefined) return { items: [], tests: 0 };
  const indexOf = new Map(rest.map((item, k) => [item, k]));
  const cache = new Map<string, boolean>();
  const test = (subset: readonly T[]): boolean => {
    const key = subset.map((item) => indexOf.get(item)).join(',');
    let verdict = cache.get(key);
    if (verdict === undefined) {
      verdict = fails([first, ...subset]);
      cache.set(key, verdict);
    }
    return verdict;
  };
  let current = rest;
  if (current.length > 0 && test([])) current = [];
  let n = 2;
  while (current.length >= 2) {
    const parts = chunks(current, Math.min(n, current.length));
    const subset = parts.find((part) => test(part));
    if (subset !== undefined) {
      current = subset;
      n = 2;
      continue;
    }
    const complement = parts.map((part) => current.filter((item) => !part.includes(item))).find((rest2) => test(rest2));
    if (complement !== undefined) {
      current = complement;
      n = Math.max(n - 1, 2);
      continue;
    }
    if (n >= current.length) break;
    n = Math.min(n * 2, current.length);
  }
  return { items: [first, ...current], tests: cache.size };
}

const sameFailure = (a: FuzzFailure, b: FuzzFailure | undefined): boolean => b !== undefined && a.check === b.check && a.kind === b.kind;

export interface MinimisedCase {
  readonly seed: number;
  readonly original: FuzzFailure;
  readonly steps: readonly FuzzStep[];
  readonly failure: FuzzFailure;
  readonly tests: number;
}

/** Minimise a failing case to the fewest steps that fail the same check on the same kind of step; null when the case passes. */
export function minimiseFuzzCase(fuzzCase: FuzzCase): MinimisedCase | null {
  const original = runFuzzSteps(fuzzCase.seed, fuzzCase.steps).failure;
  if (original === undefined) return null;
  const upTo = fuzzCase.steps.slice(0, original.step + 1);
  const { items, tests } = minimiseList(upTo, (subset) => sameFailure(original, runFuzzSteps(fuzzCase.seed, subset).failure));
  const failure = runFuzzSteps(fuzzCase.seed, items).failure ?? original;
  return { seed: fuzzCase.seed, original, steps: items, failure, tests: tests + 2 };
}
