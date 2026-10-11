/**
 * Execution context — the injected dependencies of one `execute` call.
 *
 * @layer core/commands
 * @invariant a command reads its kernel, id source and registry ONLY from its context
 *   (architecture L9, solid S5); no command touches a module-level singleton.
 * @invariant contexts nest: a command that calls `execute` (build_project, replay, recipes)
 *   runs the inner command in the caller's context unless it passes its own.
 */

import { type GeometryKernel, getGeometryKernel } from '../geometry/kernel';
import { type ReplayCache, createReplayCache } from './replayCache';
import { type IdSource, counterIdSource, withIdSource } from '../lib/id';
import type { CommandDefinition } from './types';
import { getCommand } from './registry';

export type CommandLookup = (name: string) => CommandDefinition<unknown> | undefined;

export interface ExecutionContext {
  /** Geometry kernel for booleans/fillets; null while none is installed or loaded. */
  readonly kernel: GeometryKernel | null;
  /** Mints every id the command creates. */
  readonly ids: IdSource;
  /** Resolves command names for commands that run other commands. */
  readonly registry: CommandLookup;
  /** Nesting depth of `build_project` plans (re-entrancy guard). */
  readonly projectDepth: number;
  /** Nesting depth of `instantiate_recipe` expansions (re-entrancy guard). */
  readonly recipeDepth: number;
  /**
   * Key of the feature-history step currently running, if any. A nested `execute` inside a
   * step belongs to that step: it mints from the same id source and appends no step of its own.
   */
  readonly stepKey?: string;
  /**
   * Replay prefix cache; null disables it. Results depend on the kernel, so the default
   * context keeps one cache per installed kernel.
   */
  readonly replayCache: ReplayCache | null;
}

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
