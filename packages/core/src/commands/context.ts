/**
 * Execution context — the injected dependencies of one `execute` call.
 *
 * @invariant a command reads its kernel, id source and registry ONLY from its context
 *   (architecture L9, solid S5); no command touches a module-level singleton.
 * @invariant contexts nest: a command that calls `execute` (build_project, replay, recipes)
 *   runs the inner command in the caller's context unless it passes its own.
 */

import { getGeometryKernel } from '../geometry/kernel';
import { type ReplayCache, createReplayCache } from './history/replayCache';
import { counterIdSource, withIdSource } from '../lib/id';
import type { ExecutionContext } from './types';
import { getCommand } from './commandTable';

let activeContext: ExecutionContext | null = null;

/** The value stored for `key`, created on first use. */
function getOrCreate<K extends object, V>(store: WeakMap<K, V>, key: K, create: () => V): V {
  let value = store.get(key);
  if (value === undefined) {
    value = create();
    store.set(key, value);
  }
  return value;
}

const replayCaches = new WeakMap<object, ReplayCache>();
const NO_KERNEL = {};

/**
 * Context built from the process defaults: installed kernel, counter ids, registry. The kernel
 * caches its own shapes by recipe key (`kernelFromOps`), so no wrapper is needed here.
 */
export function defaultContext(): ExecutionContext {
  const kernel = getGeometryKernel();
  return {
    kernel,
    ids: counterIdSource,
    registry: getCommand,
    projectDepth: 0,
    recipeDepth: 0,
    replayCache: getOrCreate(replayCaches, kernel ?? NO_KERNEL, createReplayCache),
  };
}

/** The context of the innermost running `execute`, else the process defaults. */
export function currentContext(): ExecutionContext {
  return activeContext ?? defaultContext();
}

/** Run `fn` with `context` active (ids minted through `context.ids`). */
export function runInContext<T>(context: ExecutionContext, fn: () => T): T {
  const previous = activeContext;
  activeContext = context;
  try {
    return withIdSource(context.ids, fn);
  } finally {
    activeContext = previous;
  }
}
