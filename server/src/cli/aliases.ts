/**
 * @layer server
 * The `as` aliases of a `run` plan that still name an entity in the final document, so an agent can
 * keep working with them (`llull mass_properties entityId=<id>`) after `$alias` is gone.
 * @pure reads the plan and the `build_project` report only
 */

import { isRecord } from '@lib/isRecord';

export interface PlanAliases {
  /** alias → entity ids it bound to that still exist in the final document. */
  readonly aliases: Record<string, string[]>;
  /** Aliases whose entities a later command consumed (boolean operands, deletions). */
  readonly consumed: string[];
}

function aliasOf(action: unknown): string | undefined {
  if (!isRecord(action)) return undefined;
  if (typeof action['as'] === 'string') return action['as'];
  const repeat = action['repeat'];
  return isRecord(repeat) && typeof repeat['as'] === 'string' ? repeat['as'] : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Null when the report has no final scene (validation, failed plan): nothing to resolve against. */
export function planAliases(actions: unknown, data: unknown): PlanAliases | null {
  if (!Array.isArray(actions) || !isRecord(data) || data['failedAt'] != null) return null;
  const scene = data['scene'];
  const steps = data['steps'];
  if (!isRecord(scene) || !Array.isArray(scene['entities']) || !Array.isArray(steps)) return null;
  const present = new Set(scene['entities'].map((entity) => (isRecord(entity) ? String(entity['id']) : '')));
  const aliases: Record<string, string[]> = {};
  const consumed: string[] = [];
  actions.forEach((action, index) => {
    const alias = aliasOf(action);
    if (alias === undefined) return;
    const ids = steps
      .filter((step) => isRecord(step) && step['index'] === index && step['ok'] === true)
      .flatMap((step) => (isRecord(step) ? stringList(step['affected']) : []));
    const alive = [...new Set(ids)].filter((id) => present.has(id));
    delete aliases[alias];
    if (alive.length > 0) aliases[alias] = alive;
    else if (!consumed.includes(alias)) consumed.push(alias);
  });
  return { aliases, consumed: consumed.filter((alias) => !(alias in aliases)) };
}

export function aliasLine(found: PlanAliases): string | null {
  const bound = Object.entries(found.aliases).map(([alias, ids]) => `${alias}=${ids.join('+')}`);
  const parts = [
    ...(bound.length > 0 ? [`Aliases: ${bound.join(', ')}`] : []),
    ...(found.consumed.length > 0 ? [`Consumed: ${found.consumed.join(', ')}`] : []),
  ];
  return parts.length > 0 ? parts.join('\n') : null;
}
