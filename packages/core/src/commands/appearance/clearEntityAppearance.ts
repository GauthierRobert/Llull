/** clear_entity_appearance — remove the visual override of entities, so the material appearance shows again (RV1 RV-M1). */

import type { Entity } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { refuseAppearance } from './refusal';

const COMMAND = 'clear_entity_appearance';

/**
 * @affects entities[id].appearance removed for every id given; affected = those ids
 * @invariant color, materialId, geometry, density and mass are untouched; all-or-nothing
 * @failure empty ids, an unknown id, or an entity without an appearance override -> no-op with APPEARANCE_TARGET_INVALID / APPEARANCE_NOT_SET
 */
export const clearEntityAppearance = defineCommand({
  name: COMMAND,
  description:
    'Remove the visual appearance override (set by apply_appearance with entityIds) from entities, so the appearance of their material shows again. ' +
    'The entity colour, material assignment, geometry and mass are untouched. Every id must exist and carry an override, otherwise nothing changes. ' +
    'Refusals carry error.code APPEARANCE_TARGET_INVALID (empty list / unknown id) or APPEARANCE_NOT_SET (entity without an override).',
  params: z.object({
    entityIds: z
      .array(z.string())
      .describe('Ids of the entities whose appearance override is removed (list_appearances shows which have one).'),
  }),
  run: (doc, params): CommandResult => {
    const ids = [...new Set(params.entityIds)];
    if (ids.length === 0) return refuseAppearance(doc, COMMAND, 'APPEARANCE_TARGET_INVALID', 'entityIds is empty', { path: 'entityIds' });
    const unknown = ids.filter((id) => !Object.hasOwn(doc.entities, id));
    if (unknown.length > 0)
      return refuseAppearance(doc, COMMAND, 'APPEARANCE_TARGET_INVALID', `no such entity: ${unknown.join(', ')}`, {
        ids: unknown,
        path: 'entityIds',
      });
    const plain = ids.filter((id) => (doc.entities[id] as Entity).appearance === undefined);
    if (plain.length > 0)
      return refuseAppearance(doc, COMMAND, 'APPEARANCE_NOT_SET', `no appearance override on: ${plain.join(', ')}`, {
        ids: plain,
        path: 'entityIds',
      });
    const entities: Record<string, Entity> = { ...doc.entities };
    for (const id of ids) {
      const { appearance, ...rest } = entities[id] as Entity;
      void appearance;
      entities[id] = rest as Entity;
    }
    return changed(
      { ...doc, entities },
      `clear_entity_appearance: removed the override of ${ids.length} entities (${ids.join(', ')}).`,
      ids,
    );
  },
});
