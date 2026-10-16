/**
 * The `as` aliases of a `run` plan that still name an entity in the final document, so an agent can
 * keep working with them (`llull mass_properties entityId=<id>`) after `$alias` is gone.
 */

import { isRecord } from '@lib/isRecord';

export interface PlanAliases {
  /** alias → entity ids it bound to that still exist in the final document. */
  readonly aliases: Record<string, string[]>;
  /** Aliases whose entities a later command consumed (boolean operands, deletions). */
  readonly consumed: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * The run report's alias map (`data.aliases`, loop aliases included) narrowed to ids still in the final scene. Null when the report has
 * no final scene or no alias map (validation, failed plan): nothing to resolve against.
 */
export function planAliases(data: unknown): PlanAliases | null {
  if (!isRecord(data) || data['failedAt'] != null || !isRecord(data['aliases'])) return null;
  const scene = data['scene'];
  if (!isRecord(scene) || !Array.isArray(scene['entities'])) return null;
  const present = new Set(scene['entities'].map((entity) => (isRecord(entity) ? String(entity['id']) : '')));
  const aliases: Record<string, string[]> = {};
  const consumed: string[] = [];
  for (const [alias, ids] of Object.entries(data['aliases'])) {
    const alive = [...new Set(stringList(ids))].filter((id) => present.has(id));
    if (alive.length > 0) aliases[alias] = alive;
    else consumed.push(alias);
  }
  return { aliases, consumed };
}

export function aliasLine(found: PlanAliases): string | null {
  const bound = Object.entries(found.aliases).map(([alias, ids]) => `${alias}=${ids.join('+')}`);
  const parts = [
    ...(bound.length > 0 ? [`Aliases: ${bound.join(', ')}`] : []),
    ...(found.consumed.length > 0 ? [`Consumed: ${found.consumed.join(', ')}`] : []),
  ];
  return parts.length > 0 ? parts.join('\n') : null;
}
