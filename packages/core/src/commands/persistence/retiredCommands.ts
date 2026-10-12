/**
 * Retired commands: tools merged into a more general command. Saved documents still name them in
 * feature-history and recipe steps (and in the actions of recorded `build_project` plans), so
 * `migrate()` rewrites every such call onto its replacement before the document is validated.
 *
 * @layer core/commands
 */

import type { RetiredCommandRewrite } from '../types';
import { isRecord } from '../../lib/isRecord';
import { pluginRetiredCommands } from '../../plugins/host';
import { RETIRED_EDIT_COMMANDS } from './retiredEditCommands';

/** Core commands folded into a more general one: old name -> rewrite onto the replacement. */
const CORE_RETIRED_COMMANDS: Readonly<Record<string, RetiredCommandRewrite>> = {
  ...RETIRED_EDIT_COMMANDS,
};

type RewriteTable = Readonly<Record<string, RetiredCommandRewrite>>;

interface Call {
  readonly name: string;
  readonly params: unknown;
}

/** The call with its nested plan calls rewritten, then itself rewritten while its name is retired. */
function rewriteCall(name: string, params: unknown, table: RewriteTable): Call {
  const nested = rewriteNested(params, table);
  const rewrite = Object.hasOwn(table, name) ? table[name] : undefined;
  if (!rewrite || !isRecord(nested)) return { name, params: nested };
  const replacement = rewrite(nested);
  return rewriteCall(replacement.name, replacement.params, table);
}

/** Rewrite every `{ command, params }` call nested in plan params (loops, steps, actions). */
function rewriteNested(value: unknown, table: RewriteTable): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteNested(item, table));
  if (!isRecord(value)) return value;
  const entries = Object.entries(value).map(([key, item]) => [key, rewriteNested(item, table)]);
  const record: Record<string, unknown> = Object.fromEntries(entries);
  if (typeof record['command'] !== 'string' || !('params' in record)) return record;
  const call = rewriteCall(record['command'], record['params'], table);
  return { ...record, command: call.name, params: call.params };
}

function migrateSteps(steps: unknown, table: RewriteTable): unknown {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step: unknown) => {
    if (!isRecord(step) || typeof step['name'] !== 'string') return step;
    const call = rewriteCall(step['name'], step['params'], table);
    return { ...step, name: call.name, params: call.params };
  });
}

/**
 * Rewrite retired command calls in `featureHistory` and every recipe's `steps`.
 * @pure
 * @invariant a document naming no retired command is returned with equal content
 */
export function migrateRetiredCommands(raw: Record<string, unknown>): Record<string, unknown> {
  const table: RewriteTable = { ...CORE_RETIRED_COMMANDS, ...pluginRetiredCommands() };
  const recipes = raw['recipes'];
  return {
    ...raw,
    featureHistory: migrateSteps(raw['featureHistory'], table),
    ...(isRecord(recipes)
      ? {
          recipes: Object.fromEntries(
            Object.entries(recipes).map(([key, recipe]) => [
              key,
              isRecord(recipe)
                ? { ...recipe, steps: migrateSteps(recipe['steps'], table) }
                : recipe,
            ]),
          ),
        }
      : {}),
  };
}
