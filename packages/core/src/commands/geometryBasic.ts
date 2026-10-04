import type { CommandResult } from './types';
import { newEntity } from './newEntity';
import { defineCommand, z, looseVec3, colorField, untypedArray } from './schema';
import { nextId } from '../lib/id';
import { replaceEntity, withoutEntities } from './entityOps';
import {
  DEFAULT_SOLID_COLOR,
  anchorField,
  commitSolid,
  positionField,
  rejectBadSize,
  resolveRotation,
  resolvePosition,
  rotationField,
  translated,
} from './geometryShared';
import { ORIGIN } from '../lib/vec3';
import { noop } from './noop';

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
export const addBox = defineCommand({
  name: 'add_box',
  description:
    'Create a rectangular box solid. Right-handed world frame, +Z up. ' +
    'size is [width, height, depth] in document units; all components must be > 0. ' +
    'anchor controls which point on the entity the position refers to: ' +
    '"center" (default) = geometric center; "min" = min-XYZ corner; "base-center" = center of bottom face (mid X/Y, min Z). ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
  params: z.object({
    size: looseVec3('[width, height, depth] in document units. All three components must be > 0.'),
    position: positionField(),
    anchor: anchorField(
      'Which point on the box the position refers to. ' +
        '"center" (default): geometric center. ' +
        '"min": min-XYZ corner of the AABB. ' +
        '"base-center": center of the bottom face (mid X/Y, min Z). ' +
        'Unknown values fall back to "center". ' +
        'Offset is applied in the local UNROTATED frame; viewport rotates about the stored origin.',
    ),
    rotation: rotationField(),
    color: colorField(DEFAULT_SOLID_COLOR),
  }),
  run: (
    doc,
    { size, position = ORIGIN, rotation, color = DEFAULT_SOLID_COLOR, anchor },
  ): CommandResult => {
    const [w, h, d] = size;
    const rejected = rejectBadSize(doc, 'add_box', size);
    if (rejected) return rejected;
    // Default anchor for box is 'center': stored position IS the geometric center.
    // Half-extents from center: [w/2, h/2, d/2].
    const storedPosition = resolvePosition([w / 2, h / 2, d / 2], 'center', anchor, position);
    const id = nextId('box');
    const entity = newEntity('box', id, { size }, storedPosition, color, {
      rotation: resolveRotation(rotation),
    });
    return commitSolid(doc, entity, `Added box ${id} of size ${size.join('×')}`);
  },
});

/**
 * @command extrude_profile
 * @pure
 * @layer core/commands
 * @affects creates 1 extrusion entity; profile is extruded along +Z from position
 * @invariant depth > 0; profile must be a non-empty array of [x,y] points
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 */

export const extrude = defineCommand({
  name: 'extrude_profile',
  description:
    'Extrude a closed 2D polygon profile along +Z into a solid. Right-handed world frame, +Z up. ' +
    'position is the origin of the profile plane [x, y, z] in document units; the solid spans ' +
    'from position.z to position.z + depth. depth must be > 0.',
  params: z.object({
    profile: untypedArray(
      'Array of [x, y] points forming a closed loop in the XY plane of the profile. ' +
        'At least 3 points are needed for a valid solid.',
    ),
    depth: z
      .number()
      .describe('Extrusion depth in document units along +Z from position. Must be > 0.'),
    position: looseVec3(
      'World-space origin of the profile plane [x, y, z] in document units. ' +
        'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
    ).optional(),
    rotation: rotationField(),
    color: colorField('#c8553d'),
  }),
  run: (doc, { profile, depth, position = ORIGIN, rotation, color = '#c8553d' }): CommandResult => {
    if (!Array.isArray(profile) || profile.length < 3) {
      return noop(
        doc,
        `extrude_profile: profile must be an array of at least 3 [x,y] points; no-op.`,
      );
    }
    if (!Number.isFinite(depth) || depth <= 0) {
      return noop(
        doc,
        `extrude_profile: depth must be a finite number > 0 (got ${String(depth)}); no-op.`,
      );
    }
    const id = nextId('ext');
    const entity = newEntity('extrusion', id, { profile, depth }, position, color, {
      rotation: resolveRotation(rotation),
    });
    return commitSolid(doc, entity, `Extruded a ${profile.length}-point profile by ${depth}`);
  },
});

export const move = defineCommand({
  name: 'move_entity',
  description: 'Translate an entity by a delta vector.',
  params: z.object({
    id: z.string().describe('Target entity id'),
    delta: looseVec3('Translation [dx,dy,dz]'),
  }),
  run: (doc, { id, delta }): CommandResult => {
    const target = doc.entities[id];
    if (!target) {
      return noop(doc, `No entity ${id} to move.`);
    }
    return {
      document: replaceEntity(doc, translated(target, delta)),
      summary: `Moved ${id} by ${delta.join(', ')}.`,
      affected: [id],
    };
  },
});

/**
 * @command delete_entity
 * @pure
 * @layer core/commands
 * @affects removes 1 entity from entities/order/selection; prunes it from all group memberIds;
 *          dissolves any group that drops below 2 members as a result
 * @invariant all remaining group memberIds exist in entities
 * @failure missing id -> no-op, affected:[]
 */
export const deleteEntity = defineCommand({
  name: 'delete_entity',
  annotations: { destructive: true },
  description:
    'Permanently remove an entity from the document, including from any groups it belongs to. ' +
    'Groups that drop below 2 members are dissolved automatically.',
  params: z.object({
    id: z.string().describe('Target entity id to delete.'),
  }),
  run: (doc, { id }): CommandResult => {
    if (!doc.entities[id]) {
      return noop(doc, `No entity ${id} to delete.`);
    }

    const { document, dissolvedGroups } = withoutEntities(doc, new Set([id]));

    const dissolveSuffix =
      dissolvedGroups.length > 0
        ? ` Dissolved group(s): [${dissolvedGroups.join(', ')}] (fell below 2 members).`
        : '';

    return {
      document,
      summary: `Deleted ${id}.${dissolveSuffix}`,
      affected: [id],
    };
  },
});
