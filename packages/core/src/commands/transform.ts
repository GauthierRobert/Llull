/**
 * Transform commands — rotate, scale, mirror, array_linear, array_polar.
 * Each is a pure function over the document (no mutations).
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 } from './schema';
import { noop } from './noop';
import { nextId } from '../lib/id';
import { MAX_COPIES_PER_COMMAND } from './limits';
import { add3, scale3 } from '../lib/vec3';
import { scale2 } from '../lib/vec2';
import { rotatePoint2 } from '../lib/polygon';
import { replaceEntity } from './entityOps';
import { rotateEulerAboutWorldZ } from '../lib/eulerRotation';

/** True for exactly three finite numbers (looseVec3 params are unchecked at the schema level). */
function isFiniteVec3(v: readonly number[]): boolean {
  return v.length === 3 && v.every(Number.isFinite);
}

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
    delta: looseVec3(
      'Euler-angle increments [dRx, dRy, dRz] in radians to add to the current rotation.',
    ),
  }),
  run: (doc, { id, delta }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return noop(doc, `No entity ${id} to rotate.`);
    }
    if (!isFiniteVec3(delta)) {
      return noop(
        doc,
        `rotate_entity: delta must be 3 finite numbers [dRx, dRy, dRz] (got [${delta.join(', ')}]); entity ${id} unchanged.`,
      );
    }
    const rotated: Entity = { ...target, rotation: add3(target.rotation, delta) };
    return {
      document: replaceEntity(doc, rotated),
      summary: `Rotated ${id} by [${delta.join(', ')}] rad; new rotation [${rotated.rotation.join(', ')}].`,
      affected: [id],
    };
  },
});

/** Scaled copy of `e` about its local origin plus the summary fragment describing the result. */
export function scaleGeometry(e: Entity, f: number): { scaled: Entity; dims: string } {
  switch (e.kind) {
    case 'box':
    case 'wedge': {
      const size = scale3(e.size, f);
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
        scaled: { ...e, profile: e.profile.map((p) => scale2(p, f)), depth },
        dims: `new depth ${depth}`,
      };
    }
    case 'line': {
      const start = scale2(e.start, f);
      const end = scale2(e.end, f);
      return {
        scaled: { ...e, start, end },
        dims: `new start [${start.join(', ')}] end [${end.join(', ')}]`,
      };
    }
    case 'polyline':
    case 'spline':
      return {
        scaled: { ...e, points: e.points.map((p) => scale2(p, f)) },
        dims: `scaled ${e.points.length} points`,
      };
    case 'arc':
    case 'circle': {
      const center = scale2(e.center, f);
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
      const center = scale2(e.center, f);
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
      const brep = e.brep && ({ op: 'scale', source: e.brep, factor: f } as const);
      return {
        scaled: { ...e, mesh: { ...e.mesh, positions }, ...(brep ? { brep } : {}) },
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
        scaled: { ...e, profile: e.profile.map((p) => scale2(p, f)) },
        dims: `scaled ${e.profile.length}-point profile`,
      };
    case 'instance': {
      const scale = scale3(e.scale ?? [1, 1, 1], f);
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
      document: replaceEntity(doc, scaled),
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
      document: replaceEntity(doc, mirrored),
      summary: `Mirrored ${id} across ${axis}-axis; new position [${newPosition.join(', ')}].`,
      affected: [id],
    };
  },
});

/** `doc` plus a copy of `source` per `{ position, rotation }` (rotation defaults to the source's); copy ids in order. */
export function addCopies(
  doc: CadDocument,
  source: Entity,
  placements: ReadonlyArray<{ position: Vec3; rotation?: Vec3 }>,
  idPrefix: string = source.kind,
): { document: CadDocument; newIds: string[] } {
  // One pass over fresh containers: re-spreading the entity bag per copy would be O(copies²).
  const entities: CadDocument['entities'] = { ...doc.entities };
  const order = [...doc.order];
  const newIds: string[] = [];
  for (const { position, rotation = source.rotation } of placements) {
    const id = nextId(idPrefix);
    entities[id] = { ...source, id, position, rotation } as Entity;
    order.push(id);
    newIds.push(id);
  }
  return { document: newIds.length === 0 ? doc : { ...doc, entities, order }, newIds };
}

/**
 * @command array_linear
 * @pure
 * @affects creates count-1 new copies of the source entity
 * @invariant count >= 2; offset must be finite; each copy k gets position = original.position + k*offset
 * @failure missing id, count < 2, or offset not 3 finite numbers -> no-op, affected:[]
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
      .int()
      .describe('Total number of instances including the original. Must be an integer >= 2.'),
    offset: looseVec3(
      'World-space translation vector [dx, dy, dz] between consecutive instances. ' +
        'All components must be finite numbers.',
    ),
  }),
  run: (doc, { id, count, offset }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return noop(doc, `array_linear: No entity ${id}.`);
    }
    if (count < 2 || count > MAX_COPIES_PER_COMMAND) {
      return noop(
        doc,
        `array_linear: count must be an integer in [2, ${MAX_COPIES_PER_COMMAND}] (got ${count}); entity ${id} unchanged.`,
      );
    }
    if (!isFiniteVec3(offset)) {
      return noop(
        doc,
        `array_linear: offset must be 3 finite numbers [dx, dy, dz] (got [${offset.join(', ')}]); entity ${id} unchanged.`,
      );
    }
    const { document, newIds } = addCopies(
      doc,
      target,
      Array.from({ length: count - 1 }, (_, i) => ({
        position: add3(target.position, scale3(offset, i + 1)),
      })),
    );
    return {
      document,
      summary:
        `Linear array of ${target.kind} ${id}: created ${newIds.length} copies ` +
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
      .int()
      .describe('Total number of instances including the original. Must be an integer >= 2.'),
    center: looseVec3(
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
    if (count < 2 || count > MAX_COPIES_PER_COMMAND) {
      return noop(
        doc,
        `array_polar: count must be an integer in [2, ${MAX_COPIES_PER_COMMAND}] (got ${count}); entity ${id} unchanged.`,
      );
    }
    if (!isFiniteVec3(center) || !Number.isFinite(angle)) {
      return noop(
        doc,
        `array_polar: center must be 3 finite numbers and angle finite (got center [${center.join(', ')}], angle ${angle}); entity ${id} unchanged.`,
      );
    }

    const [cx, cy] = center;
    const step = angle / count;
    const { document, newIds } = addCopies(
      doc,
      target,
      Array.from({ length: count - 1 }, (_, i) => {
        const theta = (i + 1) * step;
        const [rx, ry] = rotatePoint2([target.position[0] - cx, target.position[1] - cy], theta);
        return {
          position: [cx + rx, cy + ry, target.position[2]] as Vec3,
          rotation: rotateEulerAboutWorldZ(target.rotation, theta),
        };
      }),
    );
    const angleDeg = ((angle * 180) / Math.PI).toFixed(1);
    return {
      document,
      summary:
        `Polar array of ${target.kind} ${id}: created ${newIds.length} copies ` +
        `over ${angleDeg}° around center [${center[0]}, ${center[1]}]. New ids: ${newIds.join(', ')}.`,
      affected: newIds,
    };
  },
});
