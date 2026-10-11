import type { CommandResult } from '../types';
import { defineCommand, z, vec3 } from '../schema';
import { referenceSuffix, replaceEntity, withoutEntities } from '../entity/entityOps';
import { translated } from '../solids/shared';
import { changed, noop } from '../noop';

/**
 * @command move_entity
 * @pure
 * @layer core/commands
 * @affects translates 1 entity: position += delta; affected = [id]
 * @invariant only position changes; delta is in document units
 * @failure missing id -> no-op, affected:[]
 */
export const move = defineCommand({
  name: 'move_entity',
  description:
    'Translate one entity by a relative [dx, dy, dz] vector in document units (see set_units); ' +
    'its position becomes position + delta and its rotation/geometry are unchanged. ' +
    'Right-handed frame, +Z up; works on 2D shapes and 3D solids alike. ' +
    'If the id does not exist the document is left unchanged and nothing is affected.',
  params: z.object({
    id: z.string().describe('Target entity id'),
    delta: vec3(
      'Relative translation [dx, dy, dz] in document units, e.g. [10, 0, 0] moves +X by 10.',
    ),
  }),
  run: (doc, { id, delta }): CommandResult => {
    const target = doc.entities[id];
    if (!target) return noop(doc, `No entity ${id} to move.`);
    return changed(
      replaceEntity(doc, translated(target, delta)),
      `Moved ${id} by ${delta.join(', ')}.`,
      [id],
    );
  },
});

/**
 * @command delete_entity
 * @pure
 * @layer core/commands
 * @affects removes 1 entity from entities/order/selection; prunes it from all group memberIds;
 *          dissolves any group that drops below 2 members as a result
 * @invariant all remaining group memberIds exist in entities
 * @failure missing id -> no-op, affected:[]
 */
export const deleteEntity = defineCommand({
  name: 'delete_entity',
  annotations: { destructive: true },
  description:
    'Permanently remove an entity from the document, including from any groups it belongs to. ' +
    'Groups that drop below 2 members are dissolved automatically.',
  params: z.object({
    id: z.string().describe('Target entity id to delete.'),
  }),
  run: (doc, { id }): CommandResult => {
    if (!doc.entities[id]) return noop(doc, `No entity ${id} to delete.`);

    const { document, dissolvedGroups, prunedReferences } = withoutEntities(doc, new Set([id]));

    const dissolveSuffix =
      dissolvedGroups.length > 0
        ? ` Dissolved group(s): [${dissolvedGroups.join(', ')}] (fell below 2 members).`
        : '';

    return changed(
      document,
      `Deleted ${id}.${dissolveSuffix}${referenceSuffix(prunedReferences)}`,
      [id],
    );
  },
});
