/**
 * Edit commands: duplicate, group, and ungroup operations.
 *
 * @layer core/commands
 */

import type { EntityGroup } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 as vec3 } from './schema';
import { nextId } from '../lib/id';
import { ORIGIN } from '../lib/vec3';
import { changed, noop } from './noop';
import { commitEntity } from './commitEntity';
import { replaceEntity } from './entityOps';
import { translated } from './geometryShared';

/**
 * @command duplicate_entity
 * @pure
 * @layer core/commands
 * @affects creates 1 new entity with copied geometry at original.position + offset
 * @invariant new entity has a distinct id; original entity is unchanged
 * @failure missing id -> no-op, affected:[]
 */
export const duplicateEntity = defineCommand({
  name: 'duplicate_entity',
  description:
    'Clone an existing entity to a new id, placing the copy at original.position + offset. ' +
    'Returns the new entity id in affected. Original is untouched.',
  params: z.object({
    id: z.string().describe('Id of the entity to duplicate.'),
    offset: vec3(
      'Optional [dx, dy, dz] offset applied to the copy position. Defaults to [0, 0, 0] (exact overlap).',
    ).optional(),
  }),
  run: (doc, { id, offset = ORIGIN }): CommandResult => {
    const source = doc.entities[id];
    if (!source) {
      return noop(doc, `No entity ${id} to duplicate.`);
    }

    const newId = nextId(source.kind);
    return commitEntity(
      doc,
      { ...translated(source, offset), id: newId },
      `Duplicated ${id} → ${newId} at offset [${offset.join(', ')}].`,
    );
  },
});

/**
 * @command group_entities
 * @pure
 * @layer core/commands
 * @affects creates 1 new EntityGroup in doc.groups; affected = [groupId]
 * @invariant requires >= 2 valid (existing) member ids
 * @failure < 2 valid members -> no-op, affected:[]
 */
export const groupEntities = defineCommand({
  name: 'group_entities',
  description:
    'Create a named group containing >= 2 existing entities. ' +
    'The group id is returned in affected. Entities are not moved or changed.',
  params: z.object({
    ids: z
      .array(z.string())
      .describe(
        'Array of entity ids to include in the group. Must contain >= 2 ids that exist in the document.',
      ),
    name: z
      .string()
      .describe(
        'Optional human-readable label for the group, e.g. "Wheel assembly". Defaults to "Group".',
      )
      .optional(),
  }),
  run: (doc, { ids, name = 'Group' }): CommandResult => {
    const validIds = [...new Set(ids)].filter((id) => Object.hasOwn(doc.entities, id));

    if (validIds.length < 2) {
      return noop(
        doc,
        `group_entities requires >= 2 valid entity ids; got ${validIds.length} (from ${ids.length} provided).`,
      );
    }

    const groupId = nextId('group');
    const group: EntityGroup = { id: groupId, name, memberIds: validIds };

    return {
      document: {
        ...doc,
        groups: { ...doc.groups, [groupId]: group },
      },
      summary: `Created group ${groupId} ("${name}") with ${validIds.length} members: [${validIds.join(', ')}].`,
      affected: [groupId],
    };
  },
});

/**
 * @command ungroup_entities
 * @pure
 * @layer core/commands
 * @affects removes group from doc.groups; affected = former member ids
 * @invariant member entities remain in doc.entities unchanged
 * @failure missing groupId -> no-op, affected:[]
 */
export const ungroupEntities = defineCommand({
  name: 'ungroup_entities',
  description:
    'Dissolve a group, removing it from the document. Member entities are NOT deleted; ' +
    'they remain in the document. Returns the freed member ids in affected.',
  params: z.object({
    groupId: z.string().describe('Id of the group to dissolve. Must exist in doc.groups.'),
  }),
  run: (doc, { groupId }): CommandResult => {
    const group = doc.groups[groupId];

    if (!group) {
      return noop(doc, `No group ${groupId} to ungroup.`);
    }

    const nextGroups = { ...doc.groups };
    delete nextGroups[groupId];

    return changed(
      { ...doc, groups: nextGroups },
      `Ungrouped ${groupId} ("${group.name}"), freeing ${group.memberIds.length} members: [${group.memberIds.join(', ')}].`,
      [...group.memberIds],
    );
  },
});

/**
 * @command set_entity_name
 * @pure
 * @layer core/commands
 * @affects updates name and/or tags on the target entity; affected:[id]
 * @invariant entity geometry and position are not changed
 * @failure missing id -> no-op, affected:[]
 */
export const setEntityName = defineCommand({
  name: 'set_entity_name',
  annotations: { idempotent: true },
  description:
    "Set an entity's display name and/or tags. " +
    'Both fields are optional and independent — omitting a field leaves it unchanged. ' +
    'Pass name:"" to clear the name, or tags:[] to clear all tags. ' +
    'Enables AI/MCP plans to reference entities by meaning instead of generated ids, ' +
    'and allows `find_entities` to filter by name or tag.',
  params: z.object({
    id: z.string().describe('Id of the entity to label.'),
    name: z
      .string()
      .describe(
        'New display name for the entity, e.g. "Left wall". ' +
          'Omit to leave the existing name unchanged; pass an empty string to clear it.',
      )
      .optional(),
    tags: z
      .array(z.string())
      .describe(
        'Array of semantic tag strings to assign, e.g. ["structural","visible"]. ' +
          'Omit to leave existing tags unchanged. Pass [] to clear all tags.',
      )
      .optional(),
  }),
  run: (doc, { id, name, tags }): CommandResult => {
    const entity = doc.entities[id];
    if (!entity) {
      return noop(doc, `No entity ${id} — set_entity_name is a no-op.`);
    }

    const { name: currentName, tags: currentTags, ...rest } = entity;
    const nextName = name === undefined ? currentName : name === '' ? undefined : name;
    const nextTags = tags === undefined ? currentTags : tags.length > 0 ? tags : undefined;
    const patched: typeof entity = {
      ...rest,
      ...(nextName !== undefined ? { name: nextName } : {}),
      ...(nextTags !== undefined ? { tags: nextTags } : {}),
    };

    const namePart = patched.name !== undefined ? `name="${patched.name}"` : 'name=<none>';
    const tagsPart =
      patched.tags !== undefined ? `tags=[${patched.tags.join(', ')}]` : 'tags=<none>';

    return changed(replaceEntity(doc, patched), `Entity ${id}: ${namePart}, ${tagsPart}.`, [id]);
  },
});
