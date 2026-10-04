/**
 * Batch deletion — many entities in one command (one undo step).
 *
 * @layer core/commands
 */

import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { MAX_BATCH_IDS } from './limits';
import { resolveBatchIds } from './batchIds';
import { withoutEntities } from './entityOps';

/**
 * @command delete_entities
 * @pure
 * @layer core/commands
 * @affects removes every existing listed entity from entities/order/selection; prunes them from
 *          all group memberIds; dissolves any group left with fewer than 2 members
 * @invariant all remaining group memberIds exist in entities; missing/duplicate ids are skipped
 * @failure ids not a non-empty string array, > MAX_BATCH_IDS ids, or none exist -> no-op, affected:[]
 */
export const deleteEntities = defineCommand({
  name: 'delete_entities',
  annotations: { destructive: true },
  description:
    'Permanently remove several entities in one step (one undo). Same semantics as delete_entity ' +
    'applied to each id: entities are also removed from groups, and groups left with fewer than ' +
    '2 members are dissolved. Ids that do not exist are skipped and listed in the summary; ' +
    'if none exist nothing changes.',
  params: z.object({
    ids: z
      .array(z.string())
      .describe(
        `Entity ids to delete (non-empty, at most ${MAX_BATCH_IDS}). Missing ids are skipped.`,
      ),
  }),
  run: (doc, { ids }): CommandResult => {
    const batch = resolveBatchIds(
      doc,
      'delete_entities',
      ids,
      'ids must be a non-empty array of strings.',
    );
    if (!batch.ok) return batch.result;
    const { existing, missing } = batch;

    const { document, dissolvedGroups } = withoutEntities(doc, new Set(existing));

    const dissolveSuffix =
      dissolvedGroups.length > 0
        ? ` Dissolved group(s): [${dissolvedGroups.join(', ')}] (fell below 2 members).`
        : '';
    const missingSuffix = missing.length > 0 ? ` Skipped missing: [${missing.join(', ')}].` : '';

    return {
      document,
      summary: `Deleted ${existing.length} entit${existing.length === 1 ? 'y' : 'ies'} [${existing.join(', ')}].${dissolveSuffix}${missingSuffix}`,
      affected: existing,
    };
  },
});
