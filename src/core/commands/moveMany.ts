/**
 * Batch translation — many entities by one delta in one command (one undo step).
 *
 * @layer core/commands
 */

import type { Entity, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { MAX_BATCH_IDS } from './limits';

interface MoveEntitiesParams {
  ids: string[];
  delta: Vec3;
}

/**
 * @command move_entities
 * @pure
 * @layer core/commands
 * @affects translates every existing listed entity by delta; affected = the moved ids
 * @invariant only position changes; missing/duplicate ids are skipped
 * @failure ids not a non-empty string array, > MAX_BATCH_IDS ids, delta not 3 finite numbers,
 *          or none exist -> no-op, affected:[]
 */
export const moveEntities: CommandDefinition<MoveEntitiesParams> = {
  name: 'move_entities',
  description:
    'Translate several entities by the same delta in one step (one undo). Same semantics as ' +
    'move_entity applied to each id. Ids that do not exist are skipped and listed in the summary; ' +
    'if none exist nothing changes.',
  paramsSchema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        description: `Entity ids to move (non-empty, at most ${MAX_BATCH_IDS}). Missing ids are skipped.`,
        items: { type: 'string' },
      },
      delta: {
        type: 'array',
        description: 'Translation [dx, dy, dz] in document units applied to every entity.',
        items: { type: 'number' },
      },
    },
    required: ['ids', 'delta'],
  },
  run: (doc, { ids, delta }): CommandResult => {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      return {
        document: doc,
        summary: 'move_entities: ids must be a non-empty array of strings.',
        affected: [],
      };
    }
    if (ids.length > MAX_BATCH_IDS) {
      return {
        document: doc,
        summary: `move_entities: ${ids.length} ids exceeds MAX_BATCH_IDS (${MAX_BATCH_IDS}).`,
        affected: [],
      };
    }
    if (!Array.isArray(delta) || delta.length !== 3 || !delta.every(Number.isFinite)) {
      return {
        document: doc,
        summary: 'move_entities: delta must be [dx, dy, dz] of finite numbers.',
        affected: [],
      };
    }

    const unique = [...new Set(ids)];
    const existing = unique.filter((id) => Object.hasOwn(doc.entities, id));
    const missing = unique.filter((id) => !Object.hasOwn(doc.entities, id));
    if (existing.length === 0) {
      return {
        document: doc,
        summary: `move_entities: no listed entity exists (missing: [${missing.join(', ')}]).`,
        affected: [],
      };
    }

    const entities = { ...doc.entities };
    for (const id of existing) {
      const target = entities[id] as Entity;
      entities[id] = {
        ...target,
        position: [
          target.position[0] + delta[0],
          target.position[1] + delta[1],
          target.position[2] + delta[2],
        ],
      };
    }

    const missingSuffix = missing.length > 0 ? ` Skipped missing: [${missing.join(', ')}].` : '';
    return {
      document: { ...doc, entities },
      summary: `Moved ${existing.length} entit${existing.length === 1 ? 'y' : 'ies'} [${existing.join(', ')}] by [${delta.join(', ')}].${missingSuffix}`,
      affected: existing,
    };
  },
};
