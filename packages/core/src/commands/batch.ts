/**
 * Batch commands: delete_entities / move_entities / duplicate_entities act on many entities as one undo step.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, vec3, z } from './schema';
import { MAX_BATCH_IDS } from './limits';
import { referenceSuffix, withEntities, withoutEntities } from './entityOps';
import { nextId } from '../lib/id';
import { ORIGIN } from '../lib/vec3';
import { translated } from './geometryShared';
import { noop } from './noop';

type BatchIds =
  | { readonly ok: true; readonly existing: string[]; readonly missing: string[] }
  | { readonly ok: false; readonly result: CommandResult };

/**
 * Validate and split the `ids` of a batch command (`delete_entities`, `move_entities`).
 *
 * @pure
 * @param emptyDetail summary text (after `<command>: `) used when `ids` is empty
 * @failure empty, > MAX_BATCH_IDS, or no listed entity exists -> `{ ok: false, result }` no-op
 * @invariant `existing` and `missing` are de-duplicated, in first-seen order
 */
function resolveBatchIds(
  doc: CadDocument,
  command: string,
  ids: readonly string[],
  emptyDetail: string,
): BatchIds {
  const fail = (summary: string): BatchIds => ({
    ok: false,
    result: noop(doc, `${command}: ${summary}`),
  });
  if (ids.length === 0) return fail(emptyDetail);
  if (ids.length > MAX_BATCH_IDS) {
    return fail(`${ids.length} ids exceeds MAX_BATCH_IDS (${MAX_BATCH_IDS}).`);
  }
  const unique = [...new Set(ids)];
  const existing = unique.filter((id) => Object.hasOwn(doc.entities, id));
  const missing = unique.filter((id) => !Object.hasOwn(doc.entities, id));
  if (existing.length === 0) {
    return fail(`no listed entity exists (missing: [${missing.join(', ')}]).`);
  }
  return { ok: true, existing, missing };
}

/**
 * @command delete_entities
 * @pure
 * @layer core/commands
 * @affects removes every existing listed entity from entities/order/selection; prunes them from
 *          all group memberIds; dissolves any group left with fewer than 2 members
 * @invariant all remaining group memberIds exist in entities; missing/duplicate ids are skipped
 * @failure empty ids, > MAX_BATCH_IDS ids, or none exist -> no-op, affected:[]
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

    const { document, dissolvedGroups, prunedReferences } = withoutEntities(doc, new Set(existing));

    const dissolveSuffix =
      dissolvedGroups.length > 0
        ? ` Dissolved group(s): [${dissolvedGroups.join(', ')}] (fell below 2 members).`
        : '';
    const missingSuffix = missing.length > 0 ? ` Skipped missing: [${missing.join(', ')}].` : '';

    return {
      document,
      summary: `Deleted ${existing.length} entit${existing.length === 1 ? 'y' : 'ies'} [${existing.join(', ')}].${dissolveSuffix}${referenceSuffix(prunedReferences)}${missingSuffix}`,
      affected: existing,
    };
  },
});

/**
 * @command move_entities
 * @pure
 * @layer core/commands
 * @affects translates every existing listed entity by delta; affected = the moved ids
 * @invariant only position changes; missing/duplicate ids are skipped
 * @failure empty ids, > MAX_BATCH_IDS ids, or none exist -> no-op, affected:[]
 */
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

/**
 * @command duplicate_entities
 * @pure
 * @layer core/commands
 * @affects creates one copy per existing listed entity at original.position + offset; affected = the new ids in input order
 * @invariant originals are unchanged; missing/duplicate ids are skipped
 * @failure empty ids, > MAX_BATCH_IDS ids, or none exist -> no-op, affected:[]
 */
export const duplicateEntities = defineCommand({
  name: 'duplicate_entities',
  description:
    'Clone several entities in one step (one undo), placing each copy at original.position + offset. ' +
    'Same semantics as duplicate_entity applied to each id; group membership is not copied. ' +
    'Ids that do not exist are skipped and listed in the summary; if none exist nothing changes. ' +
    'Returns the new entity ids in affected, in the order of the (de-duplicated) input ids.',
  params: z.object({
    ids: z
      .array(z.string())
      .describe(
        `Entity ids to duplicate (non-empty, at most ${MAX_BATCH_IDS}). Missing ids are skipped.`,
      ),
    offset: vec3(
      'Optional [dx, dy, dz] offset applied to every copy. Defaults to [0, 0, 0] (exact overlap).',
    ).optional(),
  }),
  run: (doc, { ids, offset = ORIGIN }): CommandResult => {
    const batch = resolveBatchIds(doc, 'duplicate_entities', ids, 'ids must be a non-empty array.');
    if (!batch.ok) return batch.result;
    const { existing, missing } = batch;
    const copies = existing.map((id): Entity => {
      const source = doc.entities[id] as Entity;
      return { ...translated(source, offset), id: nextId(source.kind) };
    });
    const newIds = copies.map((copy) => copy.id);
    const missingSuffix = missing.length > 0 ? ` Skipped missing: [${missing.join(', ')}].` : '';
    return {
      document: withEntities(doc, copies),
      summary: `Duplicated ${existing.length} entit${existing.length === 1 ? 'y' : 'ies'} [${existing.join(', ')}] → [${newIds.join(', ')}] at offset [${offset.join(', ')}].${missingSuffix}`,
      affected: newIds,
    };
  },
});
