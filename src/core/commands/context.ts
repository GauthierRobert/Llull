/**
 * Execution context — the injected dependencies of one `execute` call.
 *
 * @layer core/commands
 * @invariant a command reads its kernel, id source and registry ONLY from its context
 *   (architecture L9, solid S5); no command touches a module-level singleton.
 * @invariant contexts nest: a command that calls `execute` (build_project, replay, recipes)
 *   runs the inner command in the caller's context unless it passes its own.
 */

import type { GeometryKernel } from '../geometry/kernel';
import { getGeometryKernel } from '../geometry/kernel';
import type { IdSource } from '../../lib/id';
import { counterIdSource, withIdSource } from '../../lib/id';
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
}

let activeContext: ExecutionContext | null = null;

/** Context built from the process defaults: installed kernel, counter ids, full registry. */
export function defaultContext(): ExecutionContext {
  return {
    kernel: getGeometryKernel(),
    ids: counterIdSource,
    registry: getCommand,
    projectDepth: 0,
    recipeDepth: 0,
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
