/**
 * Transform commands — rotate, scale, mirror, array_linear, array_polar.
 * Each is a pure function over the document (no mutations).
 */

import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z, looseVec3 } from '../schema';
import { changed, noop } from '../noop';
import { nextId } from '../../lib/id';
import { MAX_COPIES_PER_COMMAND } from '../limits';
import { scaleGeometry } from '../../geometry/scaleGeometry';
import { add3, isVec3, scale3, sub3 } from '../../lib/vec3';
import { applyMat3, eulerFromMat, matFromAxisAngle, matFromEulerXYZ, mulMat3, unitAxisOrNull } from '../../lib/axisRotation';
import { replaceEntity } from '../entity/entityOps';
import { rotateEulerAboutWorldZ } from '../../lib/eulerRotation';
import { toDegrees } from '../../lib/angle';

const arrayCountField = z.number().int().describe('Total number of instances including the original. Must be an integer >= 2.');

/**
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
    delta: looseVec3('Euler-angle increments [dRx, dRy, dRz] in radians to add to the current rotation.'),
  }),
  run: (doc, { id, delta }): CommandResult => {
    const target = doc.entities[id];
    if (!target) return noop(doc, `No entity ${id} to rotate.`);
    if (!isVec3(delta)) {
      return noop(
        doc,
        `rotate_entity: delta must be 3 finite numbers [dRx, dRy, dRz] (got [${(delta as readonly number[]).join(', ')}]); entity ${id} unchanged.`,
      );
    }
    const rotated: Entity = { ...target, rotation: add3(target.rotation, delta) };
    return changed(
      replaceEntity(doc, rotated),
      `Rotated ${id} by [${delta.join(', ')}] rad; new rotation [${rotated.rotation.join(', ')}].`,
      [id],
    );
  },
});

/**
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
    factor: z.number().describe('Uniform scale factor. Must be greater than 0. A value of 2 doubles the size; 0.5 halves it.'),
  }),
  run: (doc, { id, factor }): CommandResult => {
    const target = doc.entities[id];
    if (!target) return noop(doc, `No entity ${id} to scale.`);
    if (factor <= 0) return noop(doc, `scale_entity: factor must be > 0 (got ${factor}); entity ${id} unchanged.`);

    const { scaled, dims } = scaleGeometry(target, factor);
    return changed(replaceEntity(doc, scaled), `Scaled ${id} by factor ${factor}; ${dims}.`, [id]);
  },
});

type MirrorAxis = 'x' | 'y' | 'z';

const VALID_AXES: ReadonlySet<string> = new Set<MirrorAxis>(['x', 'y', 'z']);

/**
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
    axis: z.string().describe("World axis to mirror across: 'x' negates the X position component, 'y' negates Y, 'z' negates Z."),
  }),
  run: (doc, { id, axis }): CommandResult => {
    const target = doc.entities[id];
    if (!target) return noop(doc, `No entity ${id} to mirror.`);
    if (!VALID_AXES.has(axis)) {
      return noop(doc, `mirror_entity: axis must be 'x', 'y', or 'z' (got '${axis}'); entity ${id} unchanged.`);
    }

    const [px, py, pz] = target.position;
    const newPosition: Vec3 = axis === 'x' ? [-px, py, pz] : axis === 'y' ? [px, -py, pz] : [px, py, -pz];

    const mirrored: Entity = { ...target, position: newPosition };
    return changed(replaceEntity(doc, mirrored), `Mirrored ${id} across ${axis}-axis; new position [${newPosition.join(', ')}].`, [id]);
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
    count: arrayCountField,
    offset: looseVec3(
      'World-space translation vector [dx, dy, dz] between consecutive instances. ' + 'All components must be finite numbers.',
    ),
  }),
  run: (doc, { id, count, offset }): CommandResult => {
    const target = doc.entities[id];
    if (!target) return noop(doc, `array_linear: No entity ${id}.`);
    if (count < 2 || count > MAX_COPIES_PER_COMMAND) {
      return noop(doc, `array_linear: count must be an integer in [2, ${MAX_COPIES_PER_COMMAND}] (got ${count}); entity ${id} unchanged.`);
    }
    if (!isVec3(offset)) {
      return noop(
        doc,
        `array_linear: offset must be 3 finite numbers [dx, dy, dz] (got [${(offset as readonly number[]).join(', ')}]); entity ${id} unchanged.`,
      );
    }
    const { document, newIds } = addCopies(
      doc,
      target,
      Array.from({ length: count - 1 }, (_, i) => ({
        position: add3(target.position, scale3(offset, i + 1)),
      })),
    );
    return changed(
      document,
      `Linear array of ${target.kind} ${id}: created ${newIds.length} copies ` +
        `along [${offset.join(', ')}]. New ids: ${newIds.join(', ')}.`,
      newIds,
    );
  },
});

/**
 * @affects creates count-1 new copies of the source entity arranged around an axis through center
 * @invariant count >= 2; copy k is the source rotated k*(angle/count) about the axis line (position and orientation)
 * @failure missing id, count < 2 or zero-length axis -> no-op, affected:[]
 */
export const arrayPolar = defineCommand({
  name: 'array_polar',
  description:
    'Duplicate an entity into a polar (circular) pattern about an axis line through center. ' +
    'The original counts as instance 0; count-1 new copies are created. ' +
    'Copy k is the original rigidly rotated by k*(angle/count) radians about the axis: its position ' +
    'orbits the axis line and its orientation is composed with the same rotation (R_axis(k*step) applied ' +
    'after the existing rotation), so already-rotated parts (e.g. radial cylinders) stay correctly oriented. ' +
    'axis defaults to [0, 0, 1] (world Z; then center only uses cx, cy and Z position is unchanged). ' +
    'angle defaults to 2*PI (full circle). count must be >= 2.',
  params: z.object({
    id: z.string().describe('Id of the entity to array.'),
    count: arrayCountField,
    center: looseVec3(
      'World-space point [cx, cy, cz] the rotation axis passes through. ' + 'With the default Z axis only cx and cy matter.',
    ),
    axis: looseVec3(
      'Optional rotation axis direction [dx, dy, dz] (any non-zero length, normalized). Defaults to [0, 0, 1]. ' +
        'Right-hand rule gives the positive angle direction.',
    ).optional(),
    angle: z
      .number()
      .describe(
        'Total sweep angle in radians over which instances are distributed. ' +
          'Defaults to 2*PI (full 360-degree circle). A partial angle (e.g. PI) fans the instances over that arc.',
      )
      .optional(),
  }),
  run: (doc, { id, count, center, axis, angle = 2 * Math.PI }): CommandResult => {
    const target = doc.entities[id];
    if (!target) return noop(doc, `array_polar: No entity ${id}.`);
    if (count < 2 || count > MAX_COPIES_PER_COMMAND) {
      return noop(doc, `array_polar: count must be an integer in [2, ${MAX_COPIES_PER_COMMAND}] (got ${count}); entity ${id} unchanged.`);
    }
    if (!isVec3(center) || !Number.isFinite(angle)) {
      return noop(
        doc,
        `array_polar: center must be 3 finite numbers and angle finite (got center [${center.join(', ')}], angle ${angle}); entity ${id} unchanged.`,
      );
    }
    const unitAxis = axis === undefined ? ([0, 0, 1] as Vec3) : unitAxisOrNull(axis);
    if (!unitAxis) {
      return noop(doc, `array_polar: axis must be 3 finite numbers with non-zero length; entity ${id} unchanged.`);
    }

    const zAxis = unitAxis[0] === 0 && unitAxis[1] === 0 && unitAxis[2] === 1;
    const base: Vec3 = zAxis ? [center[0], center[1], target.position[2]] : center;
    const offset = sub3(target.position, base);
    const oldMatrix = matFromEulerXYZ(target.rotation);
    const step = angle / count;
    const { document, newIds } = addCopies(
      doc,
      target,
      Array.from({ length: count - 1 }, (_, i) => {
        const theta = (i + 1) * step;
        const turn = matFromAxisAngle(unitAxis, theta);
        return {
          position: add3(base, applyMat3(turn, offset)),
          rotation: zAxis ? rotateEulerAboutWorldZ(target.rotation, theta) : eulerFromMat(mulMat3(turn, oldMatrix)),
        };
      }),
    );
    const angleDeg = toDegrees(angle).toFixed(1);
    return changed(
      document,
      `Polar array of ${target.kind} ${id}: created ${newIds.length} copies ` +
        `over ${angleDeg}° about axis [${unitAxis.map((c) => +c.toFixed(6)).join(', ')}] through ` +
        `[${center.join(', ')}]. New ids: ${newIds.join(', ')}.`,
      newIds,
    );
  },
});
