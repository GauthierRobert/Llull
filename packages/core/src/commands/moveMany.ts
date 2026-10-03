/**
 * Batch translation — many entities by one delta in one command (one undo step).
 *
 * @command move_entities
 * @pure
 * @layer core/commands
 * @affects translates every existing listed entity by delta; affected = the moved ids
 * @invariant only position changes; missing/duplicate ids are skipped
 * @failure empty ids, > MAX_BATCH_IDS ids, or none exist -> no-op, affected:[]
 */

import type { CommandResult } from './types';
import { defineCommand, vec3, z } from './schema';
import { MAX_BATCH_IDS } from './limits';
import { resolveBatchIds } from './batchIds';
import { translated } from './geometryShared';

export const moveEntities = defineCommand({
  name: 'move_entities',
  description:
    'Translate several entities by the same delta in one step (one undo). Same semantics as ' +
    'move_entity applied to each id. Ids that do not exist are skipped and listed in the summary; ' +
    'if none exist nothing changes.',
  params: z.object({
    ids: z
      .array(z.string())
      .describe(
        `Entity ids to move (non-empty, at most ${MAX_BATCH_IDS}). Missing ids are skipped.`,
      ),
    delta: vec3('Translation [dx, dy, dz] in document units applied to every entity.'),
  }),
  run: (doc, { ids, delta }): CommandResult => {
    const batch = resolveBatchIds(doc, 'move_entities', ids, 'ids must be a non-empty array.');
    if (!batch.ok) return batch.result;
    const { existing, missing } = batch;
    const entities = { ...doc.entities };
    for (const id of existing) {
      const target = entities[id];
      if (target) entities[id] = translated(target, delta);
    }
    const missingSuffix = missing.length > 0 ? ` Skipped missing: [${missing.join(', ')}].` : '';
    return {
      document: { ...doc, entities },
      summary: `Moved ${existing.length} entit${existing.length === 1 ? 'y' : 'ies'} [${existing.join(', ')}] by [${delta.join(', ')}].${missingSuffix}`,
      affected: existing,
    };
  },
});
