/**
 * Entity lookup with a uniform refusal text: the entity of the wanted kind(s), else the reason.
 *
 * @layer core/commands
 * @pure
 */

import type { CadDocument, Entity } from '../../model/types';

/**
 * Entity `id` when it exists and is one of `kinds`, else the reason (no trailing punctuation):
 * `entity '<id>' not found` or `entity '<id>' is kind 'x'; expected 'a' or 'b'`.
 * Omit `kinds` to accept any kind.
 */
export function entityOfKind<K extends Entity['kind'] = Entity['kind']>(
  doc: CadDocument,
  id: string,
  kinds?: readonly K[],
): Extract<Entity, { kind: K }> | string {
  const entity = doc.entities[id];
  if (entity === undefined) return `entity '${id}' not found`;
  if (kinds !== undefined && !(kinds as readonly string[]).includes(entity.kind))
    return `entity '${id}' is kind '${entity.kind}'; expected ${kinds.map((k) => `'${k}'`).join(' or ')}`;
  return entity as Extract<Entity, { kind: K }>;
}
