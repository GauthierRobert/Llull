/**
 * Retired commands: tools merged into a more general command. Saved documents still name them in
 * feature-history and recipe steps (and in the actions of recorded `build_project` plans), so
 * `migrate()` rewrites every such call onto its replacement before the document is validated.
 *
 * @layer core/commands
 */

import type { RetiredCommandRewrite } from '../types';
import { isRecord } from '../../lib/isRecord';
import { stepKeyOf } from '../../lib/id';
import { pluginRetiredCommands } from '../../plugins/host';
import { RETIRED_EDIT_COMMANDS } from './retiredEditCommands';
import { RETIRED_DRAW_COMMANDS } from './retiredDrawCommands';
import { RETIRED_TEMPLATE_COMMANDS } from './retiredTemplateCommands';

/** Core commands folded into a more general one: old name -> rewrite onto the replacement. */
const CORE_RETIRED_COMMANDS: Readonly<Record<string, RetiredCommandRewrite>> = {
  animate_spin: (params) => ({ name: 'animate', params: { ...params, mode: 'spin' } }),
  animate_oscillate: (params) => ({ name: 'animate', params: { ...params, mode: 'oscillate' } }),
  add_mate: ({ kind, a, b, value, id }, step) => ({
    name: 'add_constraint',
    params: {
      constraint: {
        kind,
        a: { entityId: isRecord(a) ? a['instanceId'] : a },
        b: { entityId: isRecord(b) ? b['instanceId'] : b },
        ...(value !== undefined ? { value } : {}),
      },
      // A top-level add_mate minted `mate-<step>.1`; keep it so later steps still find the mate.
      ...(id !== undefined ? { id } : step ? { id: `mate-${stepKeyOf(step.id)}.1` } : {}),
    },
  }),
  ...RETIRED_EDIT_COMMANDS,
  ...RETIRED_DRAW_COMMANDS,
  ...RETIRED_TEMPLATE_COMMANDS,
};

type RewriteTable = Readonly<Record<string, RetiredCommandRewrite>>;

interface Call {
  readonly name: string;
  readonly params: unknown;
}

/** The call with its nested plan calls rewritten, then itself rewritten while its name is retired. */
function rewriteCall(
  name: string,
  params: unknown,
  table: RewriteTable,
  step?: { readonly id: string },
): Call {
  const nested = rewriteNested(params, table);
  const rewrite = Object.hasOwn(table, name) ? table[name] : undefined;
  if (!rewrite || !isRecord(nested)) return { name, params: nested };
  const replacement = rewrite(nested, step);
  return rewriteCall(replacement.name, replacement.params, table, step);
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

/** @param topLevel history steps keep their ids on replay; recipe steps are re-minted */
function migrateSteps(steps: unknown, table: RewriteTable, topLevel: boolean): unknown {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step: unknown) => {
    if (!isRecord(step) || typeof step['name'] !== 'string') return step;
    const origin = topLevel && typeof step['id'] === 'string' ? { id: step['id'] } : undefined;
    const call = rewriteCall(step['name'], step['params'], table, origin);
    return { ...step, name: call.name, params: call.params };
  });
}

function retiredTable(): RewriteTable {
  return { ...CORE_RETIRED_COMMANDS, ...pluginRetiredCommands() };
}

/**
 * Rewrite every retired `{ command, params }` call nested in `value` (plan actions, code traces).
 * @pure
 */
export function migrateRetiredCalls(value: unknown): unknown {
  return rewriteNested(value, retiredTable());
}

/**
 * Rewrite retired command calls in `featureHistory` and every recipe's `steps`.
 * @pure
 * @invariant a document naming no retired command is returned with equal content
 */
export function migrateRetiredCommands(raw: Record<string, unknown>): Record<string, unknown> {
  const table = retiredTable();
  const recipes = raw['recipes'];
  return {
    ...raw,
    featureHistory: migrateSteps(raw['featureHistory'], table, true),
    ...(isRecord(recipes)
      ? {
          recipes: Object.fromEntries(
            Object.entries(recipes).map(([key, recipe]) => [
              key,
              isRecord(recipe)
                ? { ...recipe, steps: migrateSteps(recipe['steps'], table, false) }
                : recipe,
            ]),
          ),
        }
      : {}),
  };
}
