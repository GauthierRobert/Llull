/**
 * Transform commands — rotate, scale, mirror, array_linear, array_polar.
 * Each is a pure function over the document (no mutations).
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, Vec3, Vec2 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';

// ---------------------------------------------------------------------------
// rotate_entity
// ---------------------------------------------------------------------------

interface RotateEntityParams {
  id: string;
  delta: Vec3;
}

/**
 * @command rotate_entity
 * @pure
 * @affects updates rotation on 1 entity
 * @invariant rotation is the existing Euler angles plus the delta (radians)
 * @failure missing id -> no-op, affected:[]
 */
export const rotateEntity: CommandDefinition<RotateEntityParams> = {
  name: 'rotate_entity',
  description:
    'Add Euler-angle deltas (radians) to an entity rotation. Modifies only the rotation field; position and geometry are unchanged.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the entity to rotate.' },
      delta: {
        type: 'array',
        description: 'Euler-angle increments [dRx, dRy, dRz] in radians to add to the current rotation.',
        items: { type: 'number' },
      },
    },
    required: ['id', 'delta'],
  },
  run: (doc, { id, delta }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return { document: doc, summary: `No entity ${id} to rotate.`, affected: [] };
    }
    const rotated: Entity = {
      ...target,
      rotation: [
        target.rotation[0] + delta[0],
        target.rotation[1] + delta[1],
        target.rotation[2] + delta[2],
      ],
    };
    return {
      document: { ...doc, entities: { ...doc.entities, [id]: rotated } },
      summary: `Rotated ${id} by [${delta.join(', ')}] rad; new rotation [${rotated.rotation.join(', ')}].`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// scale_entity
// ---------------------------------------------------------------------------

interface ScaleEntityParams {
  id: string;
  factor: number;
}

/**
 * @command scale_entity
 * @pure
 * @affects updates geometry dimensions on 1 entity (uniform scale)
 * @invariant factor > 0; box→size, cylinder→radius&height, sphere→radius, extrusion→profile&depth
 * @failure missing id or factor <= 0 -> no-op, affected:[]
 */
export const scaleEntity: CommandDefinition<ScaleEntityParams> = {
  name: 'scale_entity',
  description:
    'Uniformly scale an entity by a positive factor. Scales geometry in-place for all kinds — 3D: box size, cylinder radius & height, sphere radius, extrusion profile & depth; 2D: line/polyline points, arc/circle/ellipse radii, rectangle width & height, spline points (about the local origin). Position is unchanged.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the entity to scale.' },
      factor: {
        type: 'number',
        description: 'Uniform scale factor. Must be greater than 0. A value of 2 doubles the size; 0.5 halves it.',
      },
    },
    required: ['id', 'factor'],
  },
  run: (doc, { id, factor }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return { document: doc, summary: `No entity ${id} to scale.`, affected: [] };
    }
    if (factor <= 0) {
      return {
        document: doc,
        summary: `scale_entity: factor must be > 0 (got ${factor}); entity ${id} unchanged.`,
        affected: [],
      };
    }

    let scaled: Entity;
    switch (target.kind) {
      case 'box':
        scaled = {
          ...target,
          size: [target.size[0] * factor, target.size[1] * factor, target.size[2] * factor],
        };
        break;
      case 'cylinder':
        scaled = {
          ...target,
          radius: target.radius * factor,
          height: target.height * factor,
        };
        break;
      case 'sphere':
        scaled = { ...target, radius: target.radius * factor };
        break;
      case 'extrusion':
        scaled = {
          ...target,
          profile: target.profile.map(([x, y]) => [x * factor, y * factor] as const),
          depth: target.depth * factor,
        };
        break;
      case 'line':
        scaled = {
          ...target,
          start: [target.start[0] * factor, target.start[1] * factor] as Vec2,
          end: [target.end[0] * factor, target.end[1] * factor] as Vec2,
        };
        break;
      case 'polyline':
        scaled = {
          ...target,
          points: target.points.map(([x, y]) => [x * factor, y * factor] as Vec2),
        };
        break;
      case 'arc':
        scaled = {
          ...target,
          center: [target.center[0] * factor, target.center[1] * factor] as Vec2,
          radius: target.radius * factor,
        };
        break;
      case 'circle':
        scaled = {
          ...target,
          center: [target.center[0] * factor, target.center[1] * factor] as Vec2,
          radius: target.radius * factor,
        };
        break;
      case 'rectangle':
        scaled = {
          ...target,
          width: target.width * factor,
          height: target.height * factor,
        };
        break;
      case 'ellipse':
        scaled = {
          ...target,
          center: [target.center[0] * factor, target.center[1] * factor] as Vec2,
          radiusX: target.radiusX * factor,
          radiusY: target.radiusY * factor,
        };
        break;
      case 'spline':
        scaled = {
          ...target,
          points: target.points.map(([x, y]) => [x * factor, y * factor] as Vec2),
        };
        break;
      case 'point':
        // A point has no local geometry beyond position; return it unchanged.
        scaled = { ...target };
        break;
      case 'mesh':
        // Scale all world-space position triples in the flat positions array.
        scaled = {
          ...target,
          mesh: {
            ...target.mesh,
            positions: target.mesh.positions.map((v) => v * factor),
          },
        };
        break;
      case 'cone':
        scaled = {
          ...target,
          radius: target.radius * factor,
          height: target.height * factor,
        };
        break;
      case 'torus':
        scaled = {
          ...target,
          ringRadius: target.ringRadius * factor,
          tubeRadius: target.tubeRadius * factor,
        };
        break;
      case 'wedge':
        scaled = {
          ...target,
          size: [target.size[0] * factor, target.size[1] * factor, target.size[2] * factor],
        };
        break;
      case 'pyramid':
        scaled = {
          ...target,
          baseWidth: target.baseWidth * factor,
          baseDepth: target.baseDepth * factor,
          height: target.height * factor,
        };
        break;
    }

    const dims =
      scaled.kind === 'box'
        ? `new size [${scaled.size.join(', ')}]`
        : scaled.kind === 'cylinder'
          ? `new radius ${scaled.radius}, height ${scaled.height}`
          : scaled.kind === 'sphere'
            ? `new radius ${scaled.radius}`
            : scaled.kind === 'extrusion'
              ? `new depth ${scaled.depth}`
              : scaled.kind === 'mesh'
                ? `scaled ${scaled.mesh.positions.length / 3} vertices`
                : scaled.kind === 'cone'
                  ? `new radius ${scaled.radius}, height ${scaled.height}`
                  : scaled.kind === 'torus'
                    ? `new ringRadius ${scaled.ringRadius}, tubeRadius ${scaled.tubeRadius}`
                    : scaled.kind === 'wedge'
                      ? `new size [${scaled.size.join(', ')}]`
                      : scaled.kind === 'pyramid'
                        ? `new baseWidth ${scaled.baseWidth}, baseDepth ${scaled.baseDepth}, height ${scaled.height}`
                        : scaled.kind === 'line'
                          ? `new start [${scaled.start.join(', ')}] end [${scaled.end.join(', ')}]`
                          : scaled.kind === 'polyline'
                            ? `scaled ${scaled.points.length} points`
                            : scaled.kind === 'arc'
                              ? `new center [${scaled.center.join(', ')}] radius ${scaled.radius}`
                              : scaled.kind === 'circle'
                                ? `new center [${scaled.center.join(', ')}] radius ${scaled.radius}`
                                : scaled.kind === 'rectangle'
                                  ? `new size ${scaled.width}×${scaled.height}`
                                  : scaled.kind === 'ellipse'
                                    ? `new center [${scaled.center.join(', ')}] radiusX ${scaled.radiusX} radiusY ${scaled.radiusY}`
                                    : scaled.kind === 'spline'
                                      ? `scaled ${scaled.points.length} points`
                                      : 'point unchanged';
    return {
      document: { ...doc, entities: { ...doc.entities, [id]: scaled } },
      summary: `Scaled ${id} by factor ${factor}; ${dims}.`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// mirror_entity
// ---------------------------------------------------------------------------

type MirrorAxis = 'x' | 'y' | 'z';

interface MirrorEntityParams {
  id: string;
  axis: string;
}

const VALID_AXES: ReadonlySet<string> = new Set<MirrorAxis>(['x', 'y', 'z']);

/**
 * @command mirror_entity
 * @pure
 * @affects negates the matching position component of 1 entity
 * @invariant axis must be 'x', 'y', or 'z'; only position is changed
 * @failure missing id or invalid axis -> no-op, affected:[]
 */
export const mirrorEntity: CommandDefinition<MirrorEntityParams> = {
  name: 'mirror_entity',
  description:
    "Mirror an entity across the origin along a world axis by negating that axis component of its position. axis must be 'x', 'y', or 'z'.",
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the entity to mirror.' },
      axis: {
        type: 'string',
        description:
          "World axis to mirror across: 'x' negates the X position component, 'y' negates Y, 'z' negates Z.",
      },
    },
    required: ['id', 'axis'],
  },
  run: (doc, { id, axis }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return { document: doc, summary: `No entity ${id} to mirror.`, affected: [] };
    }
    if (!VALID_AXES.has(axis)) {
      return {
        document: doc,
        summary: `mirror_entity: axis must be 'x', 'y', or 'z' (got '${axis}'); entity ${id} unchanged.`,
        affected: [],
      };
    }

    const [px, py, pz] = target.position;
    const newPosition: Vec3 =
      axis === 'x' ? [-px, py, pz] : axis === 'y' ? [px, -py, pz] : [px, py, -pz];

    const mirrored: Entity = { ...target, position: newPosition };
    return {
      document: { ...doc, entities: { ...doc.entities, [id]: mirrored } },
      summary: `Mirrored ${id} across ${axis}-axis; new position [${newPosition.join(', ')}].`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// Shared helper — clone entity with a new id and new position
// ---------------------------------------------------------------------------

function cloneEntityAt(source: Entity, newPosition: Vec3): Entity {
  const id = nextId(source.kind);
  return { ...source, id, position: newPosition };
}

function withEntities(doc: CadDocument, copies: Entity[]): CadDocument {
  const newEntities = { ...doc.entities };
  const newOrder = [...doc.order];
  for (const e of copies) {
    newEntities[e.id] = e;
    newOrder.push(e.id);
  }
  return { ...doc, entities: newEntities, order: newOrder };
}

// ---------------------------------------------------------------------------
// array_linear
// ---------------------------------------------------------------------------

interface ArrayLinearParams {
  id: string;
  count: number;
  offset: Vec3;
}

/**
 * @command array_linear
 * @pure
 * @affects creates count-1 new copies of the source entity
 * @invariant count >= 2; offset must be finite; each copy k gets position = original.position + k*offset
 * @failure missing id, count < 2, or non-finite offset -> no-op, affected:[]
 */
export const arrayLinear: CommandDefinition<ArrayLinearParams> = {
  name: 'array_linear',
  description:
    'Duplicate an entity into a linear pattern. Creates count-1 new copies spaced by offset ' +
    '(a world-space vector [dx,dy,dz]). The original stays at instance 0; copy k is placed at ' +
    'original.position + k*offset (k = 1..count-1). count must be an integer >= 2.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the entity to array.' },
      count: {
        type: 'number',
        description: 'Total number of instances including the original. Must be an integer >= 2.',
      },
      offset: {
        type: 'array',
        description:
          'World-space translation vector [dx, dy, dz] between consecutive instances. ' +
          'All components must be finite numbers.',
        items: { type: 'number' },
      },
    },
    required: ['id', 'count', 'offset'],
  },
  run: (doc, { id, count, offset }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return { document: doc, summary: `array_linear: No entity ${id}.`, affected: [] };
    }
    if (!Number.isInteger(count) || count < 2) {
      return {
        document: doc,
        summary: `array_linear: count must be an integer >= 2 (got ${count}); entity ${id} unchanged.`,
        affected: [],
      };
    }
    if (
      !Number.isFinite(offset[0]) ||
      !Number.isFinite(offset[1]) ||
      !Number.isFinite(offset[2])
    ) {
      return {
        document: doc,
        summary: `array_linear: offset must be finite (got [${offset.join(', ')}]); entity ${id} unchanged.`,
        affected: [],
      };
    }

    const [ox, oy, oz] = target.position;
    const copies: Entity[] = [];
    for (let k = 1; k < count; k++) {
      const newPosition: Vec3 = [
        ox + k * offset[0],
        oy + k * offset[1],
        oz + k * offset[2],
      ];
      copies.push(cloneEntityAt(target, newPosition));
    }

    const newIds = copies.map((e) => e.id);
    return {
      document: withEntities(doc, copies),
      summary:
        `Linear array of ${target.kind} ${id}: created ${copies.length} copies ` +
        `along [${offset.join(', ')}]. New ids: ${newIds.join(', ')}.`,
      affected: newIds,
    };
  },
};

// ---------------------------------------------------------------------------
// array_polar
// ---------------------------------------------------------------------------

interface ArrayPolarParams {
  id: string;
  count: number;
  center: Vec3;
  angle?: number;
}

/**
 * @command array_polar
 * @pure
 * @affects creates count-1 new copies of the source entity arranged around a Z-axis center point
 * @invariant count >= 2; copies are distributed over total sweep angle (default 2*PI full circle)
 * @failure missing id or count < 2 -> no-op, affected:[]
 */
export const arrayPolar: CommandDefinition<ArrayPolarParams> = {
  name: 'array_polar',
  description:
    'Duplicate an entity into a polar (circular) pattern around the Z axis through center. ' +
    'The original counts as instance 0; count-1 new copies are created. ' +
    'Copy k is rotated by k*(angle/count) radians around center (XY plane). ' +
    'angle defaults to 2*PI (full circle). Each copy also has rotation[2] incremented by the same ' +
    'step so the part faces outward consistently. Z position and other rotation components are unchanged. ' +
    'count must be >= 2.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the entity to array.' },
      count: {
        type: 'number',
        description: 'Total number of instances including the original. Must be an integer >= 2.',
      },
      center: {
        type: 'array',
        description:
          'World-space center point [cx, cy, cz] for the polar rotation axis (Z axis through this point). ' +
          'Only cx and cy are used for the rotation; cz is ignored.',
        items: { type: 'number' },
      },
      angle: {
        type: 'number',
        description:
          'Total sweep angle in radians over which instances are distributed. ' +
          'Defaults to 2*PI (full 360-degree circle). A partial angle (e.g. PI) fans the instances over that arc.',
      },
    },
    required: ['id', 'count', 'center'],
  },
  run: (doc, { id, count, center, angle = 2 * Math.PI }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return { document: doc, summary: `array_polar: No entity ${id}.`, affected: [] };
    }
    if (!Number.isInteger(count) || count < 2) {
      return {
        document: doc,
        summary: `array_polar: count must be an integer >= 2 (got ${count}); entity ${id} unchanged.`,
        affected: [],
      };
    }

    const [px, py] = target.position;
    const [cx, cy] = center;
    const step = angle / count;
    const copies: Entity[] = [];

    for (let k = 1; k < count; k++) {
      const theta = k * step;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      // Rotate (px, py) around (cx, cy) by theta
      const rx = px - cx;
      const ry = py - cy;
      const newX = cx + rx * cosT - ry * sinT;
      const newY = cy + rx * sinT + ry * cosT;
      const newPosition: Vec3 = [newX, newY, target.position[2]];
      const newRotation: Vec3 = [
        target.rotation[0],
        target.rotation[1],
        target.rotation[2] + theta,
      ];
      const copy: Entity = { ...cloneEntityAt(target, newPosition), rotation: newRotation };
      copies.push(copy);
    }

    const newIds = copies.map((e) => e.id);
    const angleDeg = ((angle * 180) / Math.PI).toFixed(1);
    return {
      document: withEntities(doc, copies),
      summary:
        `Polar array of ${target.kind} ${id}: created ${copies.length} copies ` +
        `over ${angleDeg}° around center [${center[0]}, ${center[1]}]. New ids: ${newIds.join(', ')}.`,
      affected: newIds,
    };
  },
};
