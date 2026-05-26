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
import { entityBounds } from './scene';

/**
 * Validate an optional rotation param.
 * Returns [0,0,0] if rotation is absent, not length-3, or contains non-finite values.
 * Never throws — malformed rotation is silently ignored and the entity is created unrotated.
 */
function resolveRotation(rotation: unknown): Vec3 {
  if (!Array.isArray(rotation) || rotation.length !== 3) return [0, 0, 0];
  const [rx, ry, rz] = rotation as unknown[];
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) return [0, 0, 0];
  return [rx as number, ry as number, rz as number];
}

/** Format an AABB for inclusion in a command summary. */
function boundsText(b: { min: Vec3; max: Vec3 }): string {
  const fmt = (v: number): string => parseFloat(v.toFixed(4)).toString();
  return (
    `world AABB min [${b.min.map(fmt).join(', ')}] max [${b.max.map(fmt).join(', ')}]`
  );
}

/** Helper: clone the document shallowly with new entity maps. Keeps commands pure. */
function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

/**
 * @command add_box
 * @pure
 * @layer core/commands
 * @affects creates 1 box entity; position is the center of the box
 * @invariant all size components > 0
 * @failure any size component <= 0 or non-finite -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 */
interface AddBoxParams {
  size: Vec3;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
}

export const addBox: CommandDefinition<AddBoxParams> = {
  name: 'add_box',
  description:
    'Create a rectangular box solid. Right-handed world frame, +Z up. ' +
    'position is the CENTER of the box [x, y, z] in document units. ' +
    'size is [width, height, depth] in document units; all components must be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      size: {
        type: 'array',
        description:
          '[width, height, depth] in document units. All three components must be > 0.',
        items: { type: 'number' },
      },
      position: {
        type: 'array',
        description:
          'World-space center of the box [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['size'],
  },
  run: (doc, { size, position = [0, 0, 0], rotation, color = '#6b8f9c' }): CommandResult => {
    const [w, h, d] = size;
    if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(d) || w <= 0 || h <= 0 || d <= 0) {
      return {
        document: doc,
        summary: `add_box failed: all size components must be finite and > 0, got [${size.join(', ')}].`,
        affected: [],
      };
    }
    const id = nextId('box');
    const entity: Entity = {
      id,
      kind: 'box',
      size,
      position,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = entityBounds(newDoc.entities[id] as Entity);
    return {
      document: newDoc,
      summary: `Added box ${id} of size ${size.join('×')}; ${boundsText(b)}.`,
      affected: [id],
    };
  },
};

/**
 * @command extrude_profile
 * @pure
 * @layer core/commands
 * @affects creates 1 extrusion entity; profile is extruded along +Z from position
 * @invariant depth > 0; profile must be a non-empty array of [x,y] points
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 */
interface ExtrudeParams {
  profile: ReadonlyArray<readonly [number, number]>;
  depth: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
}

export const extrude: CommandDefinition<ExtrudeParams> = {
  name: 'extrude_profile',
  description:
    'Extrude a closed 2D polygon profile along +Z into a solid. Right-handed world frame, +Z up. ' +
    'position is the origin of the profile plane [x, y, z] in document units; the solid spans ' +
    'from position.z to position.z + depth. depth must be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      profile: {
        type: 'array',
        description:
          'Array of [x, y] points forming a closed loop in the XY plane of the profile. ' +
          'At least 3 points are needed for a valid solid.',
      },
      depth: {
        type: 'number',
        description: 'Extrusion depth in document units along +Z from position. Must be > 0.',
      },
      position: {
        type: 'array',
        description:
          'World-space origin of the profile plane [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#c8553d".' },
    },
    required: ['profile', 'depth'],
  },
  run: (doc, { profile, depth, position = [0, 0, 0], rotation, color = '#c8553d' }): CommandResult => {
    const id = nextId('ext');
    const entity: Entity = {
      id,
      kind: 'extrusion',
      profile,
      depth,
      position,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = entityBounds(newDoc.entities[id] as Entity);
    return {
      document: newDoc,
      summary: `Extruded a ${profile.length}-point profile by ${depth}; ${boundsText(b)}.`,
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
 * @affects creates 1 cylinder entity; position is the geometric center of the cylinder
 * @invariant radius > 0; height > 0
 * @failure radius <= 0 or height <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 *
 * NOTE: position is the CENTER of the cylinder (it spans ±height/2 along the local axis),
 * NOT the base-center. The viewport uses three.js CylinderGeometry which is Y-axis centered.
 */
interface AddCylinderParams {
  radius: number;
  height: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
}

export const addCylinder: CommandDefinition<AddCylinderParams> = {
  name: 'add_cylinder',
  description:
    'Create a cylinder solid. Right-handed world frame, +Z up. ' +
    'position is the GEOMETRIC CENTER of the cylinder [x, y, z] in document units; ' +
    'the cylinder spans ±height/2 about position along its local axis. ' +
    'radius and height must both be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      radius: {
        type: 'number',
        description: 'Radius of the cylinder cross-section in document units. Must be > 0.',
      },
      height: {
        type: 'number',
        description:
          'Total height of the cylinder in document units. The solid spans ±height/2 ' +
          'about position along its local axis. Must be > 0.',
      },
      position: {
        type: 'array',
        description:
          'World-space geometric center of the cylinder [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['radius', 'height'],
  },
  run: (doc, { radius, height, position = [0, 0, 0], rotation, color = '#6b8f9c' }): CommandResult => {
    if (!Number.isFinite(radius) || radius <= 0) {
      return { document: doc, summary: `add_cylinder failed: radius must be finite and > 0, got ${radius}.`, affected: [] };
    }
    if (!Number.isFinite(height) || height <= 0) {
      return { document: doc, summary: `add_cylinder failed: height must be finite and > 0, got ${height}.`, affected: [] };
    }
    const id = nextId('cyl');
    const entity: Entity = {
      id,
      kind: 'cylinder',
      radius,
      height,
      position,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = entityBounds(newDoc.entities[id] as Entity);
    return {
      document: newDoc,
      summary: `Added cylinder ${id} with radius ${radius} and height ${height}; ${boundsText(b)}.`,
      affected: [id],
    };
  },
};

/**
 * @command add_sphere
 * @pure
 * @layer core/commands
 * @affects creates 1 sphere entity; position is the center of the sphere
 * @invariant radius > 0
 * @failure radius <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 */
interface AddSphereParams {
  radius: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
}

export const addSphere: CommandDefinition<AddSphereParams> = {
  name: 'add_sphere',
  description:
    'Create a sphere solid. Right-handed world frame, +Z up. ' +
    'position is the CENTER of the sphere [x, y, z] in document units. ' +
    'The sphere extends ±radius in all directions from position. ' +
    'radius must be > 0. rotation is accepted and stored for uniformity but is geometrically moot.',
  paramsSchema: {
    type: 'object',
    properties: {
      radius: {
        type: 'number',
        description: 'Radius of the sphere in document units. Must be > 0.',
      },
      position: {
        type: 'array',
        description:
          'World-space center of the sphere [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
          'Stored for uniformity; geometrically moot for a sphere. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['radius'],
  },
  run: (doc, { radius, position = [0, 0, 0], rotation, color = '#6b8f9c' }): CommandResult => {
    if (!Number.isFinite(radius) || radius <= 0) {
      return { document: doc, summary: `add_sphere failed: radius must be finite and > 0, got ${radius}.`, affected: [] };
    }
    const id = nextId('sph');
    const entity: Entity = {
      id,
      kind: 'sphere',
      radius,
      position,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = entityBounds(newDoc.entities[id] as Entity);
    return {
      document: newDoc,
      summary: `Added sphere ${id} with radius ${radius}; ${boundsText(b)}.`,
      affected: [id],
    };
  },
};

/**
 * @command add_cone
 * @pure
 * @layer core/commands
 * @affects creates 1 cone entity; position is the center of the base circle
 * @invariant radius > 0; height > 0
 * @failure radius <= 0 or height <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 */
interface AddConeParams {
  radius: number;
  height: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
}

export const addCone: CommandDefinition<AddConeParams> = {
  name: 'add_cone',
  description:
    'Create a cone solid. Right-handed world frame, +Z up. ' +
    'position is the CENTER of the circular base [x, y, z] in document units; ' +
    'the apex is at position + [0, 0, height]. ' +
    'radius and height must both be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      radius: {
        type: 'number',
        description: 'Radius of the circular base in document units. Must be > 0.',
      },
      height: {
        type: 'number',
        description:
          'Height from the base center to the apex along the local +Z axis in document units. Must be > 0.',
      },
      position: {
        type: 'array',
        description:
          'World-space center of the cone base [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. The apex is at position + [0, 0, height]. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['radius', 'height'],
  },
  run: (doc, { radius, height, position = [0, 0, 0], rotation, color = '#6b8f9c' }): CommandResult => {
    if (!Number.isFinite(radius) || radius <= 0) {
      return { document: doc, summary: `add_cone failed: radius must be finite and > 0, got ${radius}.`, affected: [] };
    }
    if (!Number.isFinite(height) || height <= 0) {
      return { document: doc, summary: `add_cone failed: height must be finite and > 0, got ${height}.`, affected: [] };
    }
    const id = nextId('cone');
    const entity: Entity = {
      id,
      kind: 'cone',
      radius,
      height,
      position,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = entityBounds(newDoc.entities[id] as Entity);
    return {
      document: newDoc,
      summary: `Added cone ${id} with base radius ${radius} and height ${height}; ${boundsText(b)}.`,
      affected: [id],
    };
  },
};

/**
 * @command add_torus
 * @pure
 * @layer core/commands
 * @affects creates 1 torus entity; position is the center of the torus
 * @invariant ringRadius > 0; tubeRadius > 0
 * @failure ringRadius <= 0 or tubeRadius <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 */
interface AddTorusParams {
  ringRadius: number;
  tubeRadius: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
}

export const addTorus: CommandDefinition<AddTorusParams> = {
  name: 'add_torus',
  description:
    'Create a torus (donut) solid. Right-handed world frame, +Z up. ' +
    'position is the CENTER of the torus [x, y, z] in document units; the ring lies in the XY plane. ' +
    'ringRadius is the distance from the torus center to the tube center (major radius); ' +
    'tubeRadius is the radius of the tube cross-section (minor radius). ' +
    'Both must be > 0; tubeRadius < ringRadius for a non-self-intersecting torus.',
  paramsSchema: {
    type: 'object',
    properties: {
      ringRadius: {
        type: 'number',
        description:
          'Distance from the torus center to the center of the tube (major radius) in document units. Must be > 0.',
      },
      tubeRadius: {
        type: 'number',
        description:
          'Radius of the circular tube cross-section (minor radius) in document units. Must be > 0. ' +
          'Should be less than ringRadius for a non-self-intersecting torus.',
      },
      position: {
        type: 'array',
        description:
          'World-space center of the torus [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. The ring lies in the XY plane at this position. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['ringRadius', 'tubeRadius'],
  },
  run: (doc, { ringRadius, tubeRadius, position = [0, 0, 0], rotation, color = '#6b8f9c' }): CommandResult => {
    if (!Number.isFinite(ringRadius) || ringRadius <= 0) {
      return {
        document: doc,
        summary: `add_torus failed: ringRadius must be finite and > 0, got ${ringRadius}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(tubeRadius) || tubeRadius <= 0) {
      return {
        document: doc,
        summary: `add_torus failed: tubeRadius must be finite and > 0, got ${tubeRadius}.`,
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
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = entityBounds(newDoc.entities[id] as Entity);
    return {
      document: newDoc,
      summary: `Added torus ${id} with ringRadius ${ringRadius} and tubeRadius ${tubeRadius}; ${boundsText(b)}.`,
      affected: [id],
    };
  },
};

/**
 * @command add_wedge
 * @pure
 * @layer core/commands
 * @affects creates 1 wedge entity; position is the lower-front-left corner of the bounding box
 * @invariant all size components > 0
 * @failure any size component <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 */
interface AddWedgeParams {
  size: Vec3;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
}

export const addWedge: CommandDefinition<AddWedgeParams> = {
  name: 'add_wedge',
  description:
    'Create a wedge solid — a right-triangular prism (ramp shape). Right-handed world frame, +Z up. ' +
    'position is the LOWER-FRONT-LEFT corner of the bounding box [x, y, z] in document units. ' +
    'size is [width, height, depth]: width = X extent; height = full height of the front face (local z=0); ' +
    'depth = Z extent (ramp direction). The slope cuts the top-rear corner: front face is a full rectangle, ' +
    'back edge tapers to zero height. All size components must be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      size: {
        type: 'array',
        description:
          '[width, height, depth] in document units. width=X extent; height=full height at front face; ' +
          'depth=Z extent (ramp direction). All must be > 0.',
        items: { type: 'number' },
      },
      position: {
        type: 'array',
        description:
          'World-space lower-front-left corner of the wedge bounding box [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['size'],
  },
  run: (doc, { size, position = [0, 0, 0], rotation, color = '#6b8f9c' }): CommandResult => {
    const [w, h, d] = size;
    if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(d) || w <= 0 || h <= 0 || d <= 0) {
      return {
        document: doc,
        summary: `add_wedge failed: all size components must be finite and > 0, got [${size.join(', ')}].`,
        affected: [],
      };
    }
    const id = nextId('wdg');
    const entity: Entity = {
      id,
      kind: 'wedge',
      size,
      position,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = entityBounds(newDoc.entities[id] as Entity);
    return {
      document: newDoc,
      summary: `Added wedge ${id} of size ${size.join('×')}; ${boundsText(b)}.`,
      affected: [id],
    };
  },
};

/**
 * @command add_pyramid
 * @pure
 * @layer core/commands
 * @affects creates 1 pyramid entity; position is the center of the rectangular base
 * @invariant baseWidth > 0; baseDepth > 0; height > 0
 * @failure any dimension <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 */
interface AddPyramidParams {
  baseWidth: number;
  baseDepth: number;
  height: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
}

export const addPyramid: CommandDefinition<AddPyramidParams> = {
  name: 'add_pyramid',
  description:
    'Create a pyramid solid with a rectangular base and a single apex. Right-handed world frame, +Z up. ' +
    'position is the CENTER of the rectangular base [x, y, z] in document units. ' +
    'The base extends ±baseWidth/2 in X and ±baseDepth/2 in Y from position. ' +
    'The apex is at position + [0, 0, height]. All three dimensions must be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      baseWidth: {
        type: 'number',
        description: 'Full width of the rectangular base along X in document units. Must be > 0.',
      },
      baseDepth: {
        type: 'number',
        description: 'Full depth of the rectangular base along Y in document units. Must be > 0.',
      },
      height: {
        type: 'number',
        description:
          'Height from the base center to the apex along the local +Z axis in document units. Must be > 0.',
      },
      position: {
        type: 'array',
        description:
          'World-space center of the pyramid base [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. The apex is at position + [0, 0, height]. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
      color: { type: 'string', description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".' },
    },
    required: ['baseWidth', 'baseDepth', 'height'],
  },
  run: (doc, { baseWidth, baseDepth, height, position = [0, 0, 0], rotation, color = '#6b8f9c' }): CommandResult => {
    if (!Number.isFinite(baseWidth) || baseWidth <= 0) {
      return {
        document: doc,
        summary: `add_pyramid failed: baseWidth must be finite and > 0, got ${baseWidth}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(baseDepth) || baseDepth <= 0) {
      return {
        document: doc,
        summary: `add_pyramid failed: baseDepth must be finite and > 0, got ${baseDepth}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(height) || height <= 0) {
      return {
        document: doc,
        summary: `add_pyramid failed: height must be finite and > 0, got ${height}.`,
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
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = entityBounds(newDoc.entities[id] as Entity);
    return {
      document: newDoc,
      summary: `Added pyramid ${id} with base ${baseWidth}×${baseDepth} and height ${height}; ${boundsText(b)}.`,
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
  annotations: { destructive: true },
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
