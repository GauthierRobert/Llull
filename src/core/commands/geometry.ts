/**
 * Geometry commands. Each is a pure function over the document.
 *
 * This file intentionally shows the *pattern* with a few representative
 * commands (add box, extrude, move, delete). Adding a new tool = adding one
 * `CommandDefinition` here. The UI, AI, and MCP layers pick it up automatically
 * from the registry.
 */

import type { CadDocument, Entity, EntityGroup, Vec3 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';

/** Helper: clone the document shallowly with new entity maps. Keeps commands pure. */
function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

interface AddBoxParams {
  size: Vec3;
  position?: Vec3;
  color?: string;
}

export const addBox: CommandDefinition<AddBoxParams> = {
  name: 'add_box',
  description: 'Create a rectangular box solid at a position with a given size.',
  paramsSchema: {
    type: 'object',
    properties: {
      size: { type: 'array', description: 'Width, height, depth', items: { type: 'number' } },
      position: { type: 'array', description: 'World position [x,y,z]', items: { type: 'number' } },
      color: { type: 'string', description: 'Hex color like #c8553d' },
    },
    required: ['size'],
  },
  run: (doc, { size, position = [0, 0, 0], color = '#6b8f9c' }): CommandResult => {
    const id = nextId('box');
    const entity: Entity = {
      id,
      kind: 'box',
      size,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Added box ${id} of size ${size.join('×')}.`,
      affected: [id],
    };
  },
};

interface ExtrudeParams {
  profile: ReadonlyArray<readonly [number, number]>;
  depth: number;
  position?: Vec3;
  color?: string;
}

export const extrude: CommandDefinition<ExtrudeParams> = {
  name: 'extrude_profile',
  description: 'Extrude a closed 2D polygon profile along Z into a solid.',
  paramsSchema: {
    type: 'object',
    properties: {
      profile: { type: 'array', description: 'Array of [x,y] points forming a closed loop' },
      depth: { type: 'number', description: 'Extrusion depth along Z' },
      position: { type: 'array', description: 'World position [x,y,z]', items: { type: 'number' } },
      color: { type: 'string', description: 'Hex color' },
    },
    required: ['profile', 'depth'],
  },
  run: (doc, { profile, depth, position = [0, 0, 0], color = '#c8553d' }): CommandResult => {
    const id = nextId('ext');
    const entity: Entity = {
      id,
      kind: 'extrusion',
      profile,
      depth,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Extruded a ${profile.length}-point profile by ${depth}.`,
      affected: [id],
    };
  },
};

interface MoveParams {
  id: string;
  delta: Vec3;
}

export const move: CommandDefinition<MoveParams> = {
  name: 'move_entity',
  description: 'Translate an entity by a delta vector.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Target entity id' },
      delta: { type: 'array', description: 'Translation [dx,dy,dz]', items: { type: 'number' } },
    },
    required: ['id', 'delta'],
  },
  run: (doc, { id, delta }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return { document: doc, summary: `No entity ${id} to move.`, affected: [] };
    }
    const moved: Entity = {
      ...target,
      position: [
        target.position[0] + delta[0],
        target.position[1] + delta[1],
        target.position[2] + delta[2],
      ],
    };
    return {
      document: { ...doc, entities: { ...doc.entities, [id]: moved } },
      summary: `Moved ${id} by ${delta.join(', ')}.`,
      affected: [id],
    };
  },
};

interface DeleteParams {
  id: string;
}

/**
 * @command delete_entity
 * @pure
 * @layer core/commands
 * @affects removes 1 entity from entities/order/selection; prunes it from all group memberIds;
 *          dissolves any group that drops below 2 members as a result
 * @invariant all remaining group memberIds exist in entities
 * @failure missing id -> no-op, affected:[]
 */
export const deleteEntity: CommandDefinition<DeleteParams> = {
  name: 'delete_entity',
  description:
    'Permanently remove an entity from the document, including from any groups it belongs to. ' +
    'Groups that drop below 2 members are dissolved automatically.',
  paramsSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Target entity id to delete.' } },
    required: ['id'],
  },
  run: (doc, { id }): CommandResult => {
    if (!doc.entities[id]) {
      return { document: doc, summary: `No entity ${id} to delete.`, affected: [] };
    }

    const entities = { ...doc.entities };
    delete entities[id];

    // Prune id from all groups; dissolve groups that drop below 2 members.
    const existingGroups = doc.groups ?? {};
    const dissolvedGroups: string[] = [];
    const nextGroups: Record<string, EntityGroup> = {};
    for (const group of Object.values(existingGroups)) {
      const prunedIds = group.memberIds.filter((mid) => mid !== id);
      if (prunedIds.length < 2) {
        dissolvedGroups.push(group.id);
        // group omitted — dissolved
      } else {
        nextGroups[group.id] = { ...group, memberIds: prunedIds };
      }
    }

    const dissolveSuffix =
      dissolvedGroups.length > 0
        ? ` Dissolved group(s): [${dissolvedGroups.join(', ')}] (fell below 2 members).`
        : '';

    return {
      document: {
        ...doc,
        entities,
        order: doc.order.filter((e) => e !== id),
        selection: doc.selection.filter((e) => e !== id),
        groups: nextGroups,
      },
      summary: `Deleted ${id}.${dissolveSuffix}`,
      affected: [id],
    };
  },
};
