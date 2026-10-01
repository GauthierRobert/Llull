/**
 * Batch deletion — many entities in one command (one undo step).
 *
 * @layer core/commands
 */

import type { EntityGroup } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { MAX_BATCH_IDS } from './limits';

interface DeleteEntitiesParams {
  ids: string[];
}

/**
 * @command delete_entities
 * @pure
 * @layer core/commands
 * @affects removes every existing listed entity from entities/order/selection; prunes them from
 *          all group memberIds; dissolves any group left with fewer than 2 members
 * @invariant all remaining group memberIds exist in entities; missing/duplicate ids are skipped
 * @failure ids not a non-empty string array, > MAX_BATCH_IDS ids, or none exist -> no-op, affected:[]
 */
export const deleteEntities: CommandDefinition<DeleteEntitiesParams> = {
  name: 'delete_entities',
  annotations: { destructive: true },
  description:
    'Permanently remove several entities in one step (one undo). Same semantics as delete_entity ' +
    'applied to each id: entities are also removed from groups, and groups left with fewer than ' +
    '2 members are dissolved. Ids that do not exist are skipped and listed in the summary; ' +
    'if none exist nothing changes.',
  paramsSchema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        description: `Entity ids to delete (non-empty, at most ${MAX_BATCH_IDS}). Missing ids are skipped.`,
        items: { type: 'string' },
      },
    },
    required: ['ids'],
  },
  run: (doc, { ids }): CommandResult => {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      return {
        document: doc,
        summary: 'delete_entities: ids must be a non-empty array of strings.',
        affected: [],
      };
    }
    if (ids.length > MAX_BATCH_IDS) {
      return {
        document: doc,
        summary: `delete_entities: ${ids.length} ids exceeds MAX_BATCH_IDS (${MAX_BATCH_IDS}).`,
        affected: [],
      };
    }

    const unique = [...new Set(ids)];
    const existing = unique.filter((id) => Object.hasOwn(doc.entities, id));
    const missing = unique.filter((id) => !Object.hasOwn(doc.entities, id));
    if (existing.length === 0) {
      return {
        document: doc,
        summary: `delete_entities: no listed entity exists (missing: [${missing.join(', ')}]).`,
        affected: [],
      };
    }

    const removed = new Set(existing);
    const entities = { ...doc.entities };
    for (const id of existing) delete entities[id];

    const dissolvedGroups: string[] = [];
    const nextGroups: Record<string, EntityGroup> = {};
    for (const group of Object.values(doc.groups ?? {})) {
      const prunedIds = group.memberIds.filter((memberId) => !removed.has(memberId));
      if (prunedIds.length < 2) dissolvedGroups.push(group.id);
      else nextGroups[group.id] = { ...group, memberIds: prunedIds };
    }

    const dissolveSuffix =
      dissolvedGroups.length > 0
        ? ` Dissolved group(s): [${dissolvedGroups.join(', ')}] (fell below 2 members).`
        : '';
    const missingSuffix = missing.length > 0 ? ` Skipped missing: [${missing.join(', ')}].` : '';

    return {
      document: {
        ...doc,
        entities,
        order: doc.order.filter((id) => !removed.has(id)),
        selection: doc.selection.filter((id) => !removed.has(id)),
        groups: nextGroups,
      },
      summary: `Deleted ${existing.length} entit${existing.length === 1 ? 'y' : 'ies'} [${existing.join(', ')}].${dissolveSuffix}${missingSuffix}`,
      affected: existing,
    };
  },
};
