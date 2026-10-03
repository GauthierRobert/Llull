/**
 * Transform commands — rotate, scale, mirror, array_linear, array_polar.
 * Each is a pure function over the document (no mutations).
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, Vec3, Vec2 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 as vec3 } from './schema';
import { noop } from './noop';
import { nextId } from '../lib/id';
import { MAX_COPIES_PER_COMMAND } from './limits';

/**
 * @command rotate_entity
 * @pure
 * @affects updates rotation on 1 entity
 * @invariant rotation is the existing Euler angles plus the delta (radians)
 * @failure missing id -> no-op, affected:[]
 */
export const rotateEntity = defineCommand({
  name: 'rotate_entity',
  description:
    'Add Euler-angle deltas (radians) to an entity rotation. Modifies only the rotation field; position and geometry are unchanged.',
  params: z.object({
    id: z.string().describe('Id of the entity to rotate.'),
    delta: vec3(
      'Euler-angle increments [dRx, dRy, dRz] in radians to add to the current rotation.',
    ),
  }),
  run: (doc, { id, delta }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return noop(doc, `No entity ${id} to rotate.`);
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
});

const scaleVec2 = ([x, y]: readonly [number, number], f: number): Vec2 => [x * f, y * f];
const scaleVec3 = ([x, y, z]: readonly [number, number, number], f: number): Vec3 => [
  x * f,
  y * f,
  z * f,
];

/** Scaled copy of `e` about its local origin plus the summary fragment describing the result. */
function scaleGeometry(e: Entity, f: number): { scaled: Entity; dims: string } {
  switch (e.kind) {
    case 'box':
    case 'wedge': {
      const size = scaleVec3(e.size, f);
      return { scaled: { ...e, size }, dims: `new size [${size.join(', ')}]` };
    }
    case 'cylinder':
    case 'cone': {
      const radius = e.radius * f;
      const height = e.height * f;
      return { scaled: { ...e, radius, height }, dims: `new radius ${radius}, height ${height}` };
    }
    case 'sphere': {
      const radius = e.radius * f;
      return { scaled: { ...e, radius }, dims: `new radius ${radius}` };
    }
    case 'extrusion': {
      const depth = e.depth * f;
      return {
        scaled: { ...e, profile: e.profile.map((p) => scaleVec2(p, f)), depth },
        dims: `new depth ${depth}`,
      };
    }
    case 'line': {
      const start = scaleVec2(e.start, f);
      const end = scaleVec2(e.end, f);
      return {
        scaled: { ...e, start, end },
        dims: `new start [${start.join(', ')}] end [${end.join(', ')}]`,
      };
    }
    case 'polyline':
    case 'spline':
      return {
        scaled: { ...e, points: e.points.map((p) => scaleVec2(p, f)) },
        dims: `scaled ${e.points.length} points`,
      };
    case 'arc':
    case 'circle': {
      const center = scaleVec2(e.center, f);
      const radius = e.radius * f;
      return {
        scaled: { ...e, center, radius },
        dims: `new center [${center.join(', ')}] radius ${radius}`,
      };
    }
    case 'rectangle': {
      const width = e.width * f;
      const height = e.height * f;
      return { scaled: { ...e, width, height }, dims: `new size ${width}×${height}` };
    }
    case 'ellipse': {
      const center = scaleVec2(e.center, f);
      const radiusX = e.radiusX * f;
      const radiusY = e.radiusY * f;
      return {
        scaled: { ...e, center, radiusX, radiusY },
        dims: `new center [${center.join(', ')}] radiusX ${radiusX} radiusY ${radiusY}`,
      };
    }
    case 'text': {
      const height = e.height * f;
      return { scaled: { ...e, height }, dims: `new height ${height}` };
    }
    case 'point':
      return { scaled: { ...e }, dims: 'point unchanged' };
    case 'dimension':
      // References stay attached; only the witness-line offset is scaled.
      return e.offset === undefined
        ? { scaled: { ...e }, dims: 'offset unchanged (no offset set)' }
        : { scaled: { ...e, offset: e.offset * f }, dims: `new offset ${e.offset * f}` };
    case 'mesh': {
      const positions = e.mesh.positions.map((v) => v * f);
      return {
        scaled: { ...e, mesh: { ...e.mesh, positions } },
        dims: `scaled ${positions.length / 3} vertices`,
      };
    }
    case 'torus': {
      const ringRadius = e.ringRadius * f;
      const tubeRadius = e.tubeRadius * f;
      return {
        scaled: { ...e, ringRadius, tubeRadius },
        dims: `new ringRadius ${ringRadius}, tubeRadius ${tubeRadius}`,
      };
    }
    case 'pyramid': {
      const baseWidth = e.baseWidth * f;
      const baseDepth = e.baseDepth * f;
      const height = e.height * f;
      return {
        scaled: { ...e, baseWidth, baseDepth, height },
        dims: `new baseWidth ${baseWidth}, baseDepth ${baseDepth}, height ${height}`,
      };
    }
    case 'revolution':
      // Radial and axial profile offsets scale; axis direction is unchanged.
      return {
        scaled: { ...e, profile: e.profile.map((p) => scaleVec2(p, f)) },
        dims: `scaled ${e.profile.length}-point profile`,
      };
    case 'instance': {
      const scale = scaleVec3(e.scale ?? [1, 1, 1], f);
      return { scaled: { ...e, scale }, dims: `new scale [${scale.join(', ')}]` };
    }
  }
}

/**
 * @command scale_entity
 * @pure
 * @affects updates geometry dimensions on 1 entity (uniform scale)
 * @invariant factor > 0; box→size, cylinder→radius&height, sphere→radius, extrusion→profile&depth
 * @failure missing id or factor <= 0 -> no-op, affected:[]
 */
export const scaleEntity = defineCommand({
  name: 'scale_entity',
  description:
    'Uniformly scale an entity by a positive factor. Scales geometry in-place for all kinds — 3D: box size, cylinder radius & height, sphere radius, extrusion profile & depth; 2D: line/polyline points, arc/circle/ellipse radii, rectangle width & height, spline points (about the local origin). Position is unchanged.',
  params: z.object({
    id: z.string().describe('Id of the entity to scale.'),
    factor: z
      .number()
      .describe(
        'Uniform scale factor. Must be greater than 0. A value of 2 doubles the size; 0.5 halves it.',
      ),
  }),
  run: (doc, { id, factor }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return noop(doc, `No entity ${id} to scale.`);
    }
    if (factor <= 0) {
      return noop(doc, `scale_entity: factor must be > 0 (got ${factor}); entity ${id} unchanged.`);
    }

    const { scaled, dims } = scaleGeometry(target, factor);
    return {
      document: { ...doc, entities: { ...doc.entities, [id]: scaled } },
      summary: `Scaled ${id} by factor ${factor}; ${dims}.`,
      affected: [id],
    };
  },
});

type MirrorAxis = 'x' | 'y' | 'z';

const VALID_AXES: ReadonlySet<string> = new Set<MirrorAxis>(['x', 'y', 'z']);

/**
 * @command mirror_entity
 * @pure
 * @affects negates the matching position component of 1 entity
 * @invariant axis must be 'x', 'y', or 'z'; only position is changed
 * @failure missing id or invalid axis -> no-op, affected:[]
 */
export const mirrorEntity = defineCommand({
  name: 'mirror_entity',
  description:
    "Mirror an entity across the origin along a world axis by negating that axis component of its position. axis must be 'x', 'y', or 'z'.",
  params: z.object({
    id: z.string().describe('Id of the entity to mirror.'),
    axis: z
      .string()
      .describe(
        "World axis to mirror across: 'x' negates the X position component, 'y' negates Y, 'z' negates Z.",
      ),
  }),
  run: (doc, { id, axis }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return noop(doc, `No entity ${id} to mirror.`);
    }
    if (!VALID_AXES.has(axis)) {
      return noop(
        doc,
        `mirror_entity: axis must be 'x', 'y', or 'z' (got '${axis}'); entity ${id} unchanged.`,
      );
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
});

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

/**
 * @command array_linear
 * @pure
 * @affects creates count-1 new copies of the source entity
 * @invariant count >= 2; offset must be finite; each copy k gets position = original.position + k*offset
 * @failure missing id, count < 2, or non-finite offset -> no-op, affected:[]
 */
export const arrayLinear = defineCommand({
  name: 'array_linear',
  description:
    'Duplicate an entity into a linear pattern. Creates count-1 new copies spaced by offset ' +
    '(a world-space vector [dx,dy,dz]). The original stays at instance 0; copy k is placed at ' +
    'original.position + k*offset (k = 1..count-1). count must be an integer >= 2.',
  params: z.object({
    id: z.string().describe('Id of the entity to array.'),
    count: z
      .number()
      .describe('Total number of instances including the original. Must be an integer >= 2.'),
    offset: vec3(
      'World-space translation vector [dx, dy, dz] between consecutive instances. ' +
        'All components must be finite numbers.',
    ),
  }),
  run: (doc, { id, count, offset }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return noop(doc, `array_linear: No entity ${id}.`);
    }
    if (!Number.isInteger(count) || count < 2 || count > MAX_COPIES_PER_COMMAND) {
      return noop(
        doc,
        `array_linear: count must be an integer in [2, ${MAX_COPIES_PER_COMMAND}] (got ${count}); entity ${id} unchanged.`,
      );
    }
    if (!Number.isFinite(offset[0]) || !Number.isFinite(offset[1]) || !Number.isFinite(offset[2])) {
      return noop(
        doc,
        `array_linear: offset must be finite (got [${offset.join(', ')}]); entity ${id} unchanged.`,
      );
    }

    const [ox, oy, oz] = target.position;
    const copies: Entity[] = [];
    for (let k = 1; k < count; k++) {
      const newPosition: Vec3 = [ox + k * offset[0], oy + k * offset[1], oz + k * offset[2]];
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
});

/**
 * @command array_polar
 * @pure
 * @affects creates count-1 new copies of the source entity arranged around a Z-axis center point
 * @invariant count >= 2; copies are distributed over total sweep angle (default 2*PI full circle)
 * @failure missing id or count < 2 -> no-op, affected:[]
 */
export const arrayPolar = defineCommand({
  name: 'array_polar',
  description:
    'Duplicate an entity into a polar (circular) pattern around the Z axis through center. ' +
    'The original counts as instance 0; count-1 new copies are created. ' +
    'Copy k is rotated by k*(angle/count) radians around center (XY plane). ' +
    'angle defaults to 2*PI (full circle). Each copy also has rotation[2] incremented by the same ' +
    'step so the part faces outward consistently. Z position and other rotation components are unchanged. ' +
    'count must be >= 2.',
  params: z.object({
    id: z.string().describe('Id of the entity to array.'),
    count: z
      .number()
      .describe('Total number of instances including the original. Must be an integer >= 2.'),
    center: vec3(
      'World-space center point [cx, cy, cz] for the polar rotation axis (Z axis through this point). ' +
        'Only cx and cy are used for the rotation; cz is ignored.',
    ),
    angle: z
      .number()
      .describe(
        'Total sweep angle in radians over which instances are distributed. ' +
          'Defaults to 2*PI (full 360-degree circle). A partial angle (e.g. PI) fans the instances over that arc.',
      )
      .optional(),
  }),
  run: (doc, { id, count, center, angle = 2 * Math.PI }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return noop(doc, `array_polar: No entity ${id}.`);
    }
    if (!Number.isInteger(count) || count < 2 || count > MAX_COPIES_PER_COMMAND) {
      return noop(
        doc,
        `array_polar: count must be an integer in [2, ${MAX_COPIES_PER_COMMAND}] (got ${count}); entity ${id} unchanged.`,
      );
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
});
