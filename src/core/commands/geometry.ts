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

/**
 * @command add_cylinder
 * @pure
 * @layer core/commands
 * @affects creates 1 cylinder entity with given radius and height
 * @invariant radius > 0; height > 0
 * @failure radius <= 0 or height <= 0 -> no-op, affected:[]
 */
interface AddCylinderParams {
  radius: number;
  height: number;
  position?: Vec3;
  color?: string;
}

export const addCylinder: CommandDefinition<AddCylinderParams> = {
  name: 'add_cylinder',
  description: 'Create a cylinder solid at a position with a given radius and height.',
  paramsSchema: {
    type: 'object',
    properties: {
      radius: {
        type: 'number',
        description: 'Radius of the cylinder cross-section. Must be greater than 0.',
      },
      height: {
        type: 'number',
        description: 'Height of the cylinder along the Z axis. Must be greater than 0.',
      },
      position: {
        type: 'array',
        description: 'World-space origin [x, y, z] of the cylinder base center. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['radius', 'height'],
  },
  run: (doc, { radius, height, position = [0, 0, 0], color = '#6b8f9c' }): CommandResult => {
    if (radius <= 0) {
      return { document: doc, summary: `add_cylinder failed: radius must be > 0, got ${radius}.`, affected: [] };
    }
    if (height <= 0) {
      return { document: doc, summary: `add_cylinder failed: height must be > 0, got ${height}.`, affected: [] };
    }
    const id = nextId('cyl');
    const entity: Entity = {
      id,
      kind: 'cylinder',
      radius,
      height,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Added cylinder ${id} with radius ${radius} and height ${height}.`,
      affected: [id],
    };
  },
};

/**
 * @command add_sphere
 * @pure
 * @layer core/commands
 * @affects creates 1 sphere entity with given radius
 * @invariant radius > 0
 * @failure radius <= 0 -> no-op, affected:[]
 */
interface AddSphereParams {
  radius: number;
  position?: Vec3;
  color?: string;
}

export const addSphere: CommandDefinition<AddSphereParams> = {
  name: 'add_sphere',
  description: 'Create a sphere solid at a position with a given radius.',
  paramsSchema: {
    type: 'object',
    properties: {
      radius: {
        type: 'number',
        description: 'Radius of the sphere. Must be greater than 0.',
      },
      position: {
        type: 'array',
        description: 'World-space center position [x, y, z] of the sphere. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['radius'],
  },
  run: (doc, { radius, position = [0, 0, 0], color = '#6b8f9c' }): CommandResult => {
    if (radius <= 0) {
      return { document: doc, summary: `add_sphere failed: radius must be > 0, got ${radius}.`, affected: [] };
    }
    const id = nextId('sph');
    const entity: Entity = {
      id,
      kind: 'sphere',
      radius,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Added sphere ${id} with radius ${radius}.`,
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
