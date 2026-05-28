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
import { rotatedEntityBounds } from './scene';

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

/**
 * Placement anchor values.
 *
 * These control how the caller's `position` input is interpreted for a 3D-creation
 * command. The anchor names the point on the entity's LOCAL, UNROTATED AABB that must
 * land at the caller's `position`. The stored `position` (persisted on the entity) is
 * then the one that achieves this in the entity's own coordinate space, i.e. the offset
 * is applied BEFORE rotation. Rotation is applied by the viewport about the stored
 * origin exactly as it is today — this is an intentional, documented interaction.
 *
 * Right-handed frame, +Z up (document convention).
 *
 * | value         | anchor point (in local AABB)                                 |
 * |---------------|--------------------------------------------------------------|
 * | 'center'      | geometric center: mid X, mid Y, mid Z                        |
 * | 'min'         | min corner: min X, min Y, min Z                               |
 * | 'base-center' | center of the bottom face: mid X, mid Y, min Z                |
 */
export type PlacementAnchor = 'center' | 'min' | 'base-center';

const VALID_ANCHORS: ReadonlySet<string> = new Set<PlacementAnchor>(['center', 'min', 'base-center']);

/**
 * Compute the stored `position` so that the requested anchor lands at `inputPosition`.
 *
 * The offset is computed in the LOCAL, UNROTATED frame. Rotation is NOT applied here —
 * it is applied later by the viewport about the stored origin.
 *
 * @param halfExtents  [hx, hy, hz]: half-extents of the AABB measured from its CENTER
 *                     (the entity spans ±hx in X, ±hy in Y, ±hz in Z about the AABB center).
 *                     Always positive. Independent of `defaultAnchor` — always center-relative,
 *                     so callers pass e.g. `height/2`, not the full height.
 * @param defaultAnchor  The anchor that the stored `position` natively represents
 *                       (each command's pre-W4B convention, e.g. box='center', cone='base-center').
 * @param requestedAnchor  The anchor the CALLER named; unknown values fall back to `defaultAnchor`.
 * @param inputPosition    The world-space position the caller wants the named anchor to land at.
 * @returns The stored `position` to persist on the entity.
 */
function resolvePosition(
  halfExtents: Vec3,
  defaultAnchor: PlacementAnchor,
  requestedAnchor: unknown,
  inputPosition: Vec3,
): Vec3 {
  const anchor: PlacementAnchor =
    typeof requestedAnchor === 'string' && VALID_ANCHORS.has(requestedAnchor)
      ? (requestedAnchor as PlacementAnchor)
      : defaultAnchor;

  if (anchor === defaultAnchor) return inputPosition;

  const [hx, hy, hz] = halfExtents;

  // Anchor point relative to AABB center (canonical frame):
  // center      → [0,    0,    0   ]
  // min         → [-hx, -hy,  -hz  ]
  // base-center → [0,    0,   -hz  ]  (bottom face center; min-Z = aabbCenter.z − hz)

  function anchorOffsetFromCenter(a: PlacementAnchor): Vec3 {
    switch (a) {
      case 'center':      return [0, 0, 0];
      case 'min':         return [-hx, -hy, -hz];
      case 'base-center': return [0, 0, -hz];
    }
  }

  // Derivation (all offsets relative to AABB center):
  //   anchorPoint(a) = aabbCenter + anchorOffsetFromCenter(a)
  //   storedOrigin   = aabbCenter + anchorOffsetFromCenter(defaultAnchor)   [by definition]
  //   We want: storedOrigin + (anchorPoint(requested) - storedOrigin) = inputPosition
  //     ↔ anchorPoint(requested) = inputPosition
  //     ↔ aabbCenter + anchorOffsetFromCenter(requested) = inputPosition
  //     ↔ aabbCenter = inputPosition - anchorOffsetFromCenter(requested)
  //   And storedOrigin = aabbCenter + anchorOffsetFromCenter(defaultAnchor)
  //     = inputPosition - anchorOffsetFromCenter(requested) + anchorOffsetFromCenter(defaultAnchor)

  const defOffset = anchorOffsetFromCenter(defaultAnchor);
  const reqOffset = anchorOffsetFromCenter(anchor);

  return [
    inputPosition[0] - reqOffset[0] + defOffset[0],
    inputPosition[1] - reqOffset[1] + defOffset[1],
    inputPosition[2] - reqOffset[2] + defOffset[2],
  ];
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
 * @affects creates 1 box entity
 * @invariant all size components > 0
 * @failure any size component <= 0 or non-finite -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 * @failure unknown anchor value -> falls back to default anchor 'center', no throw
 */
interface AddBoxParams {
  size: Vec3;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  anchor?: PlacementAnchor;
}

export const addBox: CommandDefinition<AddBoxParams> = {
  name: 'add_box',
  description:
    'Create a rectangular box solid. Right-handed world frame, +Z up. ' +
    'size is [width, height, depth] in document units; all components must be > 0. ' +
    'anchor controls which point on the entity the position refers to: ' +
    '"center" (default) = geometric center; "min" = min-XYZ corner; "base-center" = center of bottom face (mid X/Y, min Z). ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
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
          'World-space location of the anchor point [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      anchor: {
        type: 'string',
        description:
          'Which point on the box the position refers to. ' +
          '"center" (default): geometric center. ' +
          '"min": min-XYZ corner of the AABB. ' +
          '"base-center": center of the bottom face (mid X/Y, min Z). ' +
          'Unknown values fall back to "center". ' +
          'Offset is applied in the local UNROTATED frame; viewport rotates about the stored origin.',
        enum: ['center', 'min', 'base-center'],
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
  run: (doc, { size, position = [0, 0, 0], rotation, color = '#6b8f9c', anchor }): CommandResult => {
    const [w, h, d] = size;
    if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(d) || w <= 0 || h <= 0 || d <= 0) {
      return {
        document: doc,
        summary: `add_box failed: all size components must be finite and > 0, got [${size.join(', ')}].`,
        affected: [],
      };
    }
    // Default anchor for box is 'center': stored position IS the geometric center.
    // Half-extents from center: [w/2, h/2, d/2].
    const storedPosition = resolvePosition([w / 2, h / 2, d / 2], 'center', anchor, position);
    const id = nextId('box');
    const entity: Entity = {
      id,
      kind: 'box',
      size,
      position: storedPosition,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);
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
    if (!Array.isArray(profile) || profile.length < 3) {
      return {
        document: doc,
        summary: `extrude_profile: profile must be an array of at least 3 [x,y] points; no-op.`,
        affected: [],
      };
    }
    if (!Number.isFinite(depth) || depth <= 0) {
      return {
        document: doc,
        summary: `extrude_profile: depth must be a finite number > 0 (got ${String(depth)}); no-op.`,
        affected: [],
      };
    }
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
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);
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
 * @affects creates 1 cylinder entity; stored position is the geometric center of the cylinder
 * @invariant radius > 0; height > 0
 * @failure radius <= 0 or height <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 * @failure unknown anchor value -> falls back to default anchor 'center', no throw
 *
 * NOTE: the viewport renders via three.js CylinderGeometry (Y-axis centered). The document
 * frame is +Z up, so entityBounds uses ±height/2 on the Y axis. Default anchor is 'center'.
 */
interface AddCylinderParams {
  radius: number;
  height: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  anchor?: PlacementAnchor;
}

export const addCylinder: CommandDefinition<AddCylinderParams> = {
  name: 'add_cylinder',
  description:
    'Create a cylinder solid. Right-handed world frame, +Z up. ' +
    'radius and height must both be > 0. ' +
    'anchor controls which point the position refers to: ' +
    '"center" (default) = geometric center (cylinder spans ±height/2 about stored position along its axis); ' +
    '"min" = min-XYZ corner of the AABB; ' +
    '"base-center" = center of the bottom face (mid X/Y, min Z of AABB). ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
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
          'Total height of the cylinder in document units. Must be > 0.',
      },
      position: {
        type: 'array',
        description:
          'World-space location of the anchor point [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      anchor: {
        type: 'string',
        description:
          'Which point on the cylinder the position refers to. ' +
          '"center" (default): geometric center. ' +
          '"min": min-XYZ corner of the AABB. ' +
          '"base-center": center of the bottom face (mid X/Y, min Z). ' +
          'Unknown values fall back to "center". ' +
          'Offset is applied in the local UNROTATED frame; viewport rotates about the stored origin.',
        enum: ['center', 'min', 'base-center'],
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
  run: (doc, { radius, height, position = [0, 0, 0], rotation, color = '#6b8f9c', anchor }): CommandResult => {
    if (!Number.isFinite(radius) || radius <= 0) {
      return { document: doc, summary: `add_cylinder failed: radius must be finite and > 0, got ${radius}.`, affected: [] };
    }
    if (!Number.isFinite(height) || height <= 0) {
      return { document: doc, summary: `add_cylinder failed: height must be finite and > 0, got ${height}.`, affected: [] };
    }
    // Default anchor for cylinder is 'center': stored position is the geometric center.
    // AABB half-extents from center: [radius, height/2, radius].
    // (entityBounds uses Y axis for height per three.js CylinderGeometry convention.)
    const storedPosition = resolvePosition([radius, height / 2, radius], 'center', anchor, position);
    const id = nextId('cyl');
    const entity: Entity = {
      id,
      kind: 'cylinder',
      radius,
      height,
      position: storedPosition,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);
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
 * @affects creates 1 sphere entity; stored position is the center of the sphere
 * @invariant radius > 0
 * @failure radius <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 * @failure unknown anchor value -> falls back to default anchor 'center', no throw
 */
interface AddSphereParams {
  radius: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  anchor?: PlacementAnchor;
}

export const addSphere: CommandDefinition<AddSphereParams> = {
  name: 'add_sphere',
  description:
    'Create a sphere solid. Right-handed world frame, +Z up. ' +
    'radius must be > 0. rotation is accepted and stored for uniformity but is geometrically moot. ' +
    'anchor controls which point the position refers to: ' +
    '"center" (default) = geometric center; "min" = min-XYZ corner of the AABB; ' +
    '"base-center" = center of the bottom face (mid X/Y, min Z). ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
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
          'World-space location of the anchor point [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      anchor: {
        type: 'string',
        description:
          'Which point on the sphere the position refers to. ' +
          '"center" (default): geometric center. ' +
          '"min": min-XYZ corner of the AABB. ' +
          '"base-center": center of the bottom face (mid X/Y, min Z). ' +
          'Unknown values fall back to "center". ' +
          'Offset is applied in the local UNROTATED frame; viewport rotates about the stored origin.',
        enum: ['center', 'min', 'base-center'],
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
  run: (doc, { radius, position = [0, 0, 0], rotation, color = '#6b8f9c', anchor }): CommandResult => {
    if (!Number.isFinite(radius) || radius <= 0) {
      return { document: doc, summary: `add_sphere failed: radius must be finite and > 0, got ${radius}.`, affected: [] };
    }
    // Default anchor for sphere is 'center': stored position is the geometric center.
    // Half-extents from center: [radius, radius, radius].
    const storedPosition = resolvePosition([radius, radius, radius], 'center', anchor, position);
    const id = nextId('sph');
    const entity: Entity = {
      id,
      kind: 'sphere',
      radius,
      position: storedPosition,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);
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
 * @affects creates 1 cone entity; stored position is the center of the base circle (base-center)
 * @invariant radius > 0; height > 0
 * @failure radius <= 0 or height <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 * @failure unknown anchor value -> falls back to default anchor 'base-center', no throw
 *
 * Default anchor is 'base-center': the stored position is the center of the circular base;
 * the AABB spans [pos-radius..pos+radius, pos-radius..pos+radius, pos.z..pos.z+height].
 */
interface AddConeParams {
  radius: number;
  height: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  anchor?: PlacementAnchor;
}

export const addCone: CommandDefinition<AddConeParams> = {
  name: 'add_cone',
  description:
    'Create a cone solid. Right-handed world frame, +Z up. ' +
    'radius and height must both be > 0. ' +
    'anchor controls which point the position refers to: ' +
    '"base-center" (default) = center of the circular base (the apex is at position + [0,0,height]); ' +
    '"center" = geometric center of the AABB; ' +
    '"min" = min-XYZ corner of the AABB. ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
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
          'World-space location of the anchor point [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      anchor: {
        type: 'string',
        description:
          'Which point on the cone the position refers to. ' +
          '"base-center" (default): center of the circular base; apex at position+[0,0,height]. ' +
          '"center": geometric center of the AABB (mid X/Y/Z). ' +
          '"min": min-XYZ corner of the AABB. ' +
          'Unknown values fall back to "base-center". ' +
          'Offset is applied in the local UNROTATED frame; viewport rotates about the stored origin.',
        enum: ['center', 'min', 'base-center'],
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
  run: (doc, { radius, height, position = [0, 0, 0], rotation, color = '#6b8f9c', anchor }): CommandResult => {
    if (!Number.isFinite(radius) || radius <= 0) {
      return { document: doc, summary: `add_cone failed: radius must be finite and > 0, got ${radius}.`, affected: [] };
    }
    if (!Number.isFinite(height) || height <= 0) {
      return { document: doc, summary: `add_cone failed: height must be finite and > 0, got ${height}.`, affected: [] };
    }
    // Default anchor for cone is 'base-center': stored position IS the base center.
    // AABB from base-center origin: spans [−radius..+radius, −radius..+radius, 0..height].
    // To use resolvePosition (which works from center), we express the base-center origin
    // relative to the AABB center: AABB center is at [0, 0, height/2] from base-center.
    // We pass half-extents as seen from the AABB center: [radius, radius, height/2].
    // defaultAnchor='base-center' tells resolvePosition the stored origin is the base-center.
    const storedPosition = resolvePosition([radius, radius, height / 2], 'base-center', anchor, position);
    const id = nextId('cone');
    const entity: Entity = {
      id,
      kind: 'cone',
      radius,
      height,
      position: storedPosition,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);
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
 * @affects creates 1 torus entity; stored position is the geometric center of the torus
 * @invariant ringRadius > 0; tubeRadius > 0
 * @failure ringRadius <= 0 or tubeRadius <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 * @failure unknown anchor value -> falls back to default anchor 'center', no throw
 *
 * Default anchor is 'center': the stored position is the geometric center of the torus.
 * AABB: ±(ringRadius+tubeRadius) in X/Y; ±tubeRadius in Z.
 */
interface AddTorusParams {
  ringRadius: number;
  tubeRadius: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  anchor?: PlacementAnchor;
}

export const addTorus: CommandDefinition<AddTorusParams> = {
  name: 'add_torus',
  description:
    'Create a torus (donut) solid. Right-handed world frame, +Z up. ' +
    'ringRadius is the distance from the torus center to the tube center (major radius); ' +
    'tubeRadius is the radius of the tube cross-section (minor radius). ' +
    'Both must be > 0; tubeRadius < ringRadius for a non-self-intersecting torus. ' +
    'anchor controls which point the position refers to: ' +
    '"center" (default) = geometric center of the torus; "min" = min-XYZ corner of the AABB; ' +
    '"base-center" = center of the bottom face (mid X/Y, min Z). ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
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
          'World-space location of the anchor point [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. The ring lies in the XY plane. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      anchor: {
        type: 'string',
        description:
          'Which point on the torus the position refers to. ' +
          '"center" (default): geometric center. ' +
          '"min": min-XYZ corner of the AABB. ' +
          '"base-center": center of the bottom face (mid X/Y, min Z). ' +
          'Unknown values fall back to "center". ' +
          'Offset is applied in the local UNROTATED frame; viewport rotates about the stored origin.',
        enum: ['center', 'min', 'base-center'],
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
  run: (doc, { ringRadius, tubeRadius, position = [0, 0, 0], rotation, color = '#6b8f9c', anchor }): CommandResult => {
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
    // Default anchor for torus is 'center': stored position is the geometric center.
    // AABB half-extents from center: [ringRadius+tubeRadius, ringRadius+tubeRadius, tubeRadius].
    const outerRadius = ringRadius + tubeRadius;
    const storedPosition = resolvePosition([outerRadius, outerRadius, tubeRadius], 'center', anchor, position);
    const id = nextId('tor');
    const entity: Entity = {
      id,
      kind: 'torus',
      ringRadius,
      tubeRadius,
      position: storedPosition,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);
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
 * @affects creates 1 wedge entity; stored position is the lower-front-left corner of the bounding box
 * @invariant all size components > 0
 * @failure any size component <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 * @failure unknown anchor value -> falls back to default anchor 'min', no throw
 *
 * Default anchor is 'min': the stored position is the lower-front-left (min-XYZ) corner.
 * AABB: [position..position+size] in all axes.
 */
interface AddWedgeParams {
  size: Vec3;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  anchor?: PlacementAnchor;
}

export const addWedge: CommandDefinition<AddWedgeParams> = {
  name: 'add_wedge',
  description:
    'Create a wedge solid — a right-triangular prism (ramp shape). Right-handed world frame, +Z up. ' +
    'size is [width, height, depth]: width = X extent; height = full height of the front face; ' +
    'depth = Z extent (ramp direction). The slope cuts the top-rear corner: front face is a full rectangle, ' +
    'back edge tapers to zero height. All size components must be > 0. ' +
    'anchor controls which point the position refers to: ' +
    '"min" (default) = lower-front-left corner of the bounding box (min-XYZ); ' +
    '"center" = geometric center of the AABB; ' +
    '"base-center" = center of the bottom face (mid X/Y, min Z). ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
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
          'World-space location of the anchor point [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      anchor: {
        type: 'string',
        description:
          'Which point on the wedge the position refers to. ' +
          '"min" (default): lower-front-left corner of the bounding box (min-XYZ). ' +
          '"center": geometric center of the AABB. ' +
          '"base-center": center of the bottom face (mid X/Y, min Z). ' +
          'Unknown values fall back to "min". ' +
          'Offset is applied in the local UNROTATED frame; viewport rotates about the stored origin.',
        enum: ['center', 'min', 'base-center'],
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
  run: (doc, { size, position = [0, 0, 0], rotation, color = '#6b8f9c', anchor }): CommandResult => {
    const [w, h, d] = size;
    if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(d) || w <= 0 || h <= 0 || d <= 0) {
      return {
        document: doc,
        summary: `add_wedge failed: all size components must be finite and > 0, got [${size.join(', ')}].`,
        affected: [],
      };
    }
    // Default anchor for wedge is 'min': stored position is the lower-front-left (min-XYZ) corner.
    // AABB half-extents from min corner: [w/2, h/2, d/2] (half-extents measured from min = stored origin).
    const storedPosition = resolvePosition([w / 2, h / 2, d / 2], 'min', anchor, position);
    const id = nextId('wdg');
    const entity: Entity = {
      id,
      kind: 'wedge',
      size,
      position: storedPosition,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);
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
 * @affects creates 1 pyramid entity; stored position is the center of the rectangular base
 * @invariant baseWidth > 0; baseDepth > 0; height > 0
 * @failure any dimension <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 * @failure unknown anchor value -> falls back to default anchor 'base-center', no throw
 *
 * Default anchor is 'base-center': the stored position is the center of the rectangular base.
 * AABB from base-center: ±baseWidth/2 in X; ±baseDepth/2 in Y; 0..height in Z.
 */
interface AddPyramidParams {
  baseWidth: number;
  baseDepth: number;
  height: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  anchor?: PlacementAnchor;
}

export const addPyramid: CommandDefinition<AddPyramidParams> = {
  name: 'add_pyramid',
  description:
    'Create a pyramid solid with a rectangular base and a single apex. Right-handed world frame, +Z up. ' +
    'The base extends ±baseWidth/2 in X and ±baseDepth/2 in Y from the anchor point. ' +
    'The apex is at base-center + [0, 0, height]. All three dimensions must be > 0. ' +
    'anchor controls which point the position refers to: ' +
    '"base-center" (default) = center of the rectangular base; apex at position+[0,0,height]; ' +
    '"center" = geometric center of the AABB; ' +
    '"min" = min-XYZ corner of the AABB. ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
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
          'World-space location of the anchor point [x, y, z] in document units. ' +
          'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
        items: { type: 'number' },
      },
      anchor: {
        type: 'string',
        description:
          'Which point on the pyramid the position refers to. ' +
          '"base-center" (default): center of the rectangular base; apex at position+[0,0,height]. ' +
          '"center": geometric center of the AABB (mid X/Y/Z). ' +
          '"min": min-XYZ corner of the AABB. ' +
          'Unknown values fall back to "base-center". ' +
          'Offset is applied in the local UNROTATED frame; viewport rotates about the stored origin.',
        enum: ['center', 'min', 'base-center'],
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
  run: (doc, { baseWidth, baseDepth, height, position = [0, 0, 0], rotation, color = '#6b8f9c', anchor }): CommandResult => {
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
    // Default anchor for pyramid is 'base-center': stored position IS the base center.
    // AABB from base-center origin: spans [−bw/2..+bw/2, −bd/2..+bd/2, 0..height].
    // Half-extents for resolvePosition (which works from AABB center internally):
    // pass half-extents as seen from base-center: [baseWidth/2, baseDepth/2, height/2].
    const storedPosition = resolvePosition([baseWidth / 2, baseDepth / 2, height / 2], 'base-center', anchor, position);
    const id = nextId('pyr');
    const entity: Entity = {
      id,
      kind: 'pyramid',
      baseWidth,
      baseDepth,
      height,
      position: storedPosition,
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    const newDoc = withEntity(doc, entity);
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);
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
