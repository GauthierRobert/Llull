/**
 * Edit commands: duplicate, group, and ungroup operations.
 *
 * @layer core/commands
 */

import type { Entity, EntityGroup, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
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

interface DuplicateEntityParams {
  id: string;
  offset?: Vec3;
}

/**
 * @command duplicate_entity
 * @pure
 * @layer core/commands
 * @affects creates 1 new entity with copied geometry at original.position + offset
 * @invariant new entity has a distinct id; original entity is unchanged
 * @failure missing id -> no-op, affected:[]
 */
export const duplicateEntity: CommandDefinition<DuplicateEntityParams> = {
  name: 'duplicate_entity',
  description:
    'Clone an existing entity to a new id, placing the copy at original.position + offset. ' +
    'Returns the new entity id in affected. Original is untouched.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the entity to duplicate.' },
      offset: {
        type: 'array',
        description:
          'Optional [dx, dy, dz] offset applied to the copy position. Defaults to [0, 0, 0] (exact overlap).',
        items: { type: 'number' },
      },
    },
    required: ['id'],
  },
  run: (doc, { id, offset = [0, 0, 0] }): CommandResult => {
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
};

// ---------------------------------------------------------------------------
// group_entities
// ---------------------------------------------------------------------------

interface GroupEntitiesParams {
  ids: string[];
  name?: string;
}

/**
 * @command group_entities
 * @pure
 * @layer core/commands
 * @affects creates 1 new EntityGroup in doc.groups; affected = [groupId]
 * @invariant requires >= 2 valid (existing) member ids
 * @failure < 2 valid members -> no-op, affected:[]
 */
export const groupEntities: CommandDefinition<GroupEntitiesParams> = {
  name: 'group_entities',
  description:
    'Create a named group containing >= 2 existing entities. ' +
    'The group id is returned in affected. Entities are not moved or changed.',
  paramsSchema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        description: 'Array of entity ids to include in the group. Must contain >= 2 ids that exist in the document.',
        items: { type: 'string' },
      },
      name: {
        type: 'string',
        description: 'Optional human-readable label for the group, e.g. "Wheel assembly". Defaults to "Group".',
      },
    },
    required: ['ids'],
  },
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
};

// ---------------------------------------------------------------------------
// ungroup_entities
// ---------------------------------------------------------------------------

interface UngroupEntitiesParams {
  groupId: string;
}

/**
 * @command ungroup_entities
 * @pure
 * @layer core/commands
 * @affects removes group from doc.groups; affected = former member ids
 * @invariant member entities remain in doc.entities unchanged
 * @failure missing groupId -> no-op, affected:[]
 */
export const ungroupEntities: CommandDefinition<UngroupEntitiesParams> = {
  name: 'ungroup_entities',
  description:
    'Dissolve a group, removing it from the document. Member entities are NOT deleted; ' +
    'they remain in the document. Returns the freed member ids in affected.',
  paramsSchema: {
    type: 'object',
    properties: {
      groupId: {
        type: 'string',
        description: 'Id of the group to dissolve. Must exist in doc.groups.',
      },
    },
    required: ['groupId'],
  },
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
};

// ---------------------------------------------------------------------------
// set_entity_name
// ---------------------------------------------------------------------------

interface SetEntityNameParams {
  id: string;
  name?: string;
  tags?: readonly string[];
}

/**
 * @command set_entity_name
 * @pure
 * @layer core/commands
 * @affects updates name and/or tags on the target entity; affected:[id]
 * @invariant entity geometry and position are not changed
 * @failure missing id -> no-op, affected:[]
 */
export const setEntityName: CommandDefinition<SetEntityNameParams> = {
  name: 'set_entity_name',
  description:
    'Set an entity\'s display name and/or tags. ' +
    'Both fields are optional and independent — omitting a field leaves it unchanged. ' +
    'Pass name:"" to clear the name, or tags:[] to clear all tags. ' +
    'Enables AI/MCP plans to reference entities by meaning instead of generated ids, ' +
    'and allows `find_entities` to filter by name or tag.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the entity to label.' },
      name: {
        type: 'string',
        description:
          'New display name for the entity, e.g. "Left wall". ' +
          'Omit to leave the existing name unchanged; pass an empty string to clear it.',
      },
      tags: {
        type: 'array',
        description:
          'Array of semantic tag strings to assign, e.g. ["structural","visible"]. ' +
          'Omit to leave existing tags unchanged. Pass [] to clear all tags.',
        items: { type: 'string' },
      },
    },
    required: ['id'],
  },
  run: (doc, { id, name, tags }): CommandResult => {
    const entity = doc.entities[id];
    if (!entity) {
      return { document: doc, summary: `No entity ${id} — set_entity_name is a no-op.`, affected: [] };
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
};

// Re-export for barrel convenience
export const editCommands = [duplicateEntity, groupEntities, ungroupEntities, setEntityName];
