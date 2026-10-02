/**
 * Edit commands: duplicate, group, and ungroup operations.
 *
 * @layer core/commands
 */

import type { Entity, EntityGroup, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 as vec3 } from './schema';
import { nextId } from '../../lib/id';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Shallow-clone an entity with a new id and adjusted position.
 * Written locally to avoid cross-command-file coupling (transform.ts is off-limits).
 */
function cloneEntity(source: Entity, newId: string, position: Vec3): Entity {
  return { ...source, id: newId, position } as Entity;
}

// ---------------------------------------------------------------------------
// duplicate_entity
// ---------------------------------------------------------------------------

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
  run: (doc, { id, offset = [0, 0, 0] as const }): CommandResult => {
    const source = doc.entities[id];
    if (!source) {
      return { document: doc, summary: `No entity ${id} to duplicate.`, affected: [] };
    }

    const newId = nextId(source.kind);
    const newPosition: Vec3 = [
      source.position[0] + offset[0],
      source.position[1] + offset[1],
      source.position[2] + offset[2],
    ];
    const copy = cloneEntity(source, newId, newPosition);

    return {
      document: {
        ...doc,
        entities: { ...doc.entities, [newId]: copy },
        order: [...doc.order, newId],
      },
      summary: `Duplicated ${id} → ${newId} at offset [${offset.join(', ')}].`,
      affected: [newId],
    };
  },
});

// ---------------------------------------------------------------------------
// group_entities
// ---------------------------------------------------------------------------

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
    const existingGroups = doc.groups ?? {};
    const validIds = ids.filter((id) => id in doc.entities);

    if (validIds.length < 2) {
      return {
        document: doc,
        summary: `group_entities requires >= 2 valid entity ids; got ${validIds.length} (from ${ids.length} provided).`,
        affected: [],
      };
    }

    const groupId = nextId('group');
    const group: EntityGroup = { id: groupId, name, memberIds: validIds };

    return {
      document: {
        ...doc,
        groups: { ...existingGroups, [groupId]: group },
      },
      summary: `Created group ${groupId} ("${name}") with ${validIds.length} members: [${validIds.join(', ')}].`,
      affected: [groupId],
    };
  },
});

// ---------------------------------------------------------------------------
// ungroup_entities
// ---------------------------------------------------------------------------

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
    const existingGroups = doc.groups ?? {};
    const group = existingGroups[groupId];

    if (!group) {
      return {
        document: doc,
        summary: `No group ${groupId} to ungroup.`,
        affected: [],
      };
    }

    const nextGroups = { ...existingGroups };
    delete nextGroups[groupId];

    return {
      document: { ...doc, groups: nextGroups },
      summary: `Ungrouped ${groupId} ("${group.name}"), freeing ${group.memberIds.length} members: [${group.memberIds.join(', ')}].`,
      affected: [...group.memberIds],
    };
  },
});

// ---------------------------------------------------------------------------
// set_entity_name
// ---------------------------------------------------------------------------

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
      return {
        document: doc,
        summary: `No entity ${id} — set_entity_name is a no-op.`,
        affected: [],
      };
    }

    // Build a patched entity; only override fields that were provided.
    // exactOptionalPropertyTypes: spread undefined to omit, or override with value.
    const patched: typeof entity = {
      ...entity,
      ...(name !== undefined ? { name: name === '' ? undefined : name } : {}),
      ...(tags !== undefined ? { tags: tags.length > 0 ? tags : undefined } : {}),
    } as typeof entity;

    const namePart = patched.name !== undefined ? `name="${patched.name}"` : 'name=<none>';
    const tagsPart =
      patched.tags !== undefined ? `tags=[${patched.tags.join(', ')}]` : 'tags=<none>';

    return {
      document: {
        ...doc,
        entities: { ...doc.entities, [id]: patched },
      },
      summary: `Entity ${id}: ${namePart}, ${tagsPart}.`,
      affected: [id],
    };
  },
});

// Re-export for barrel convenience
export const editCommands = [duplicateEntity, groupEntities, ungroupEntities, setEntityName];
