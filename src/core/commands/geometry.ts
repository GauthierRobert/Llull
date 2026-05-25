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

/**
 * @command add_cone
 * @pure
 * @layer core/commands
 * @affects creates 1 cone entity with given radius and height
 * @invariant radius > 0; height > 0
 * @failure radius <= 0 or height <= 0 -> no-op, affected:[]
 */
interface AddConeParams {
  radius: number;
  height: number;
  position?: Vec3;
  color?: string;
}

export const addCone: CommandDefinition<AddConeParams> = {
  name: 'add_cone',
  description:
    'Create a cone solid. The circular base is centered at position in the XY plane; the apex ' +
    'is directly above the base center along +Z by height units.',
  paramsSchema: {
    type: 'object',
    properties: {
      radius: {
        type: 'number',
        description: 'Radius of the circular base. Must be greater than 0.',
      },
      height: {
        type: 'number',
        description: 'Height from the base center to the apex along the local +Z axis. Must be greater than 0.',
      },
      position: {
        type: 'array',
        description: 'World-space center of the cone base [x, y, z]. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['radius', 'height'],
  },
  run: (doc, { radius, height, position = [0, 0, 0], color = '#6b8f9c' }): CommandResult => {
    if (radius <= 0) {
      return { document: doc, summary: `add_cone failed: radius must be > 0, got ${radius}.`, affected: [] };
    }
    if (height <= 0) {
      return { document: doc, summary: `add_cone failed: height must be > 0, got ${height}.`, affected: [] };
    }
    const id = nextId('cone');
    const entity: Entity = {
      id,
      kind: 'cone',
      radius,
      height,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Added cone ${id} with base radius ${radius} and height ${height}.`,
      affected: [id],
    };
  },
};

/**
 * @command add_torus
 * @pure
 * @layer core/commands
 * @affects creates 1 torus entity with given ringRadius and tubeRadius
 * @invariant ringRadius > 0; tubeRadius > 0
 * @failure ringRadius <= 0 or tubeRadius <= 0 -> no-op, affected:[]
 */
interface AddTorusParams {
  ringRadius: number;
  tubeRadius: number;
  position?: Vec3;
  color?: string;
}

export const addTorus: CommandDefinition<AddTorusParams> = {
  name: 'add_torus',
  description:
    'Create a torus (donut) solid centered at position. ringRadius is the distance from the torus ' +
    'center to the center of the tube (major radius); tubeRadius is the radius of the tube cross-section ' +
    '(minor radius). For a valid non-self-intersecting torus, tubeRadius should be less than ringRadius.',
  paramsSchema: {
    type: 'object',
    properties: {
      ringRadius: {
        type: 'number',
        description:
          'Distance from the torus center to the center of the tube (major radius). Must be greater than 0.',
      },
      tubeRadius: {
        type: 'number',
        description:
          'Radius of the circular tube cross-section (minor radius). Must be greater than 0. ' +
          'Should be less than ringRadius for a non-self-intersecting torus.',
      },
      position: {
        type: 'array',
        description: 'World-space center of the torus [x, y, z]. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['ringRadius', 'tubeRadius'],
  },
  run: (doc, { ringRadius, tubeRadius, position = [0, 0, 0], color = '#6b8f9c' }): CommandResult => {
    if (ringRadius <= 0) {
      return {
        document: doc,
        summary: `add_torus failed: ringRadius must be > 0, got ${ringRadius}.`,
        affected: [],
      };
    }
    if (tubeRadius <= 0) {
      return {
        document: doc,
        summary: `add_torus failed: tubeRadius must be > 0, got ${tubeRadius}.`,
        affected: [],
      };
    }
    const id = nextId('tor');
    const entity: Entity = {
      id,
      kind: 'torus',
      ringRadius,
      tubeRadius,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Added torus ${id} with ringRadius ${ringRadius} and tubeRadius ${tubeRadius}.`,
      affected: [id],
    };
  },
};

/**
 * @command add_wedge
 * @pure
 * @layer core/commands
 * @affects creates 1 wedge entity with given size [width, height, depth]
 * @invariant all size components > 0
 * @failure any size component <= 0 -> no-op, affected:[]
 */
interface AddWedgeParams {
  size: Vec3;
  position?: Vec3;
  color?: string;
}

export const addWedge: CommandDefinition<AddWedgeParams> = {
  name: 'add_wedge',
  description:
    'Create a wedge solid — a right-triangular prism (ramp shape). size is [width, height, depth]: ' +
    'width is the extent along X; height is the full height of the front face (at z=0, local space); ' +
    'depth is the extent along Z (the ramp direction). The slope cuts the top-rear corner: ' +
    'the front face (z=0) is a full rectangle and the back edge (z=depth) tapers to zero height. ' +
    'position is at the lower-front-left corner. All size components must be greater than 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      size: {
        type: 'array',
        description:
          'Bounding dimensions [width, height, depth]. width=X extent; height=full height at front face (z=0); ' +
          'depth=Z extent (ramp direction). All must be > 0.',
        items: { type: 'number' },
      },
      position: {
        type: 'array',
        description: 'World-space position of the lower-front-left corner [x, y, z]. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['size'],
  },
  run: (doc, { size, position = [0, 0, 0], color = '#6b8f9c' }): CommandResult => {
    const [w, h, d] = size;
    if (w <= 0 || h <= 0 || d <= 0) {
      return {
        document: doc,
        summary: `add_wedge failed: all size components must be > 0, got [${size.join(', ')}].`,
        affected: [],
      };
    }
    const id = nextId('wdg');
    const entity: Entity = {
      id,
      kind: 'wedge',
      size,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Added wedge ${id} of size ${size.join('×')}.`,
      affected: [id],
    };
  },
};

/**
 * @command add_pyramid
 * @pure
 * @layer core/commands
 * @affects creates 1 pyramid entity with given baseWidth, baseDepth, and height
 * @invariant baseWidth > 0; baseDepth > 0; height > 0
 * @failure any dimension <= 0 -> no-op, affected:[]
 */
interface AddPyramidParams {
  baseWidth: number;
  baseDepth: number;
  height: number;
  position?: Vec3;
  color?: string;
}

export const addPyramid: CommandDefinition<AddPyramidParams> = {
  name: 'add_pyramid',
  description:
    'Create a pyramid solid with a rectangular base and a single apex above the base center. ' +
    'position is the world-space center of the rectangular base. The base extends ±baseWidth/2 in X ' +
    'and ±baseDepth/2 in Y from position. The apex is at position + [0, 0, height]. ' +
    'All three dimensions must be greater than 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      baseWidth: {
        type: 'number',
        description: 'Width of the rectangular base along the X axis (full extent). Must be greater than 0.',
      },
      baseDepth: {
        type: 'number',
        description: 'Depth of the rectangular base along the Y axis (full extent). Must be greater than 0.',
      },
      height: {
        type: 'number',
        description: 'Height from the base center to the apex along the local +Z axis. Must be greater than 0.',
      },
      position: {
        type: 'array',
        description: 'World-space center of the pyramid base [x, y, z]. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['baseWidth', 'baseDepth', 'height'],
  },
  run: (doc, { baseWidth, baseDepth, height, position = [0, 0, 0], color = '#6b8f9c' }): CommandResult => {
    if (baseWidth <= 0) {
      return {
        document: doc,
        summary: `add_pyramid failed: baseWidth must be > 0, got ${baseWidth}.`,
        affected: [],
      };
    }
    if (baseDepth <= 0) {
      return {
        document: doc,
        summary: `add_pyramid failed: baseDepth must be > 0, got ${baseDepth}.`,
        affected: [],
      };
    }
    if (height <= 0) {
      return {
        document: doc,
        summary: `add_pyramid failed: height must be > 0, got ${height}.`,
        affected: [],
      };
    }
    const id = nextId('pyr');
    const entity: Entity = {
      id,
      kind: 'pyramid',
      baseWidth,
      baseDepth,
      height,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Added pyramid ${id} with base ${baseWidth}×${baseDepth} and height ${height}.`,
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
