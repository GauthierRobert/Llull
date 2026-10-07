import type { CommandResult } from './types';
import { newEntity } from './newEntity';
import { defineCommand, z, looseVec3, vec3, colorField, untypedArray } from './schema';
import { nextId } from '../lib/id';
import { referenceSuffix, replaceEntity, withoutEntities } from './entityOps';
import {
  DEFAULT_SOLID_COLOR,
  EXTRUSION_COLOR,
  anchorField,
  commitSolid,
  placeSolid,
  positionField,
  rejectBadProfile,
  rejectBadSize,
  rotationField,
  translated,
} from './geometryShared';
import { ORIGIN, finiteVec3OrZero } from '../lib/vec3';
import { noop } from './noop';
import { MAX_PROFILE_POINTS } from './limits';

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
    anchor: anchorField('box', 'center'),
    rotation: rotationField(),
    color: colorField(DEFAULT_SOLID_COLOR),
  }),
  run: (
    doc,
    { size, position = ORIGIN, rotation, color = DEFAULT_SOLID_COLOR, anchor },
  ): CommandResult => {
    const rejected = rejectBadSize(doc, 'add_box', size);
    if (rejected) return rejected;
    const [w, h, d] = size;
    return placeSolid(doc, {
      kind: 'box',
      idPrefix: 'box',
      geometry: { size },
      halfExtents: [w / 2, h / 2, d / 2],
      defaultAnchor: 'center',
      anchor,
      position,
      rotation,
      color,
      describe: (id) => `Added box ${id} of size ${size.join('×')}`,
    });
  },
});

/**
 * @command extrude_profile
 * @pure
 * @layer core/commands
 * @affects creates 1 extrusion entity; profile is extruded along +Z from position
 * @invariant depth > 0; profile has >= 3 points, each a finite [x,y] pair
 * @failure profile < 3 points or any point not a finite [x,y] pair -> no-op, affected:[]
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
    color: colorField(EXTRUSION_COLOR),
  }),
  run: (
    doc,
    { profile, depth, position = ORIGIN, rotation, color = EXTRUSION_COLOR },
  ): CommandResult => {
    if (profile.length < 3) {
      return noop(
        doc,
        `extrude_profile: profile must be an array of at least 3 [x,y] points; no-op.`,
      );
    }
    if (profile.length > MAX_PROFILE_POINTS) {
      return noop(
        doc,
        `extrude_profile: profile has ${profile.length} points, exceeding MAX_PROFILE_POINTS (${MAX_PROFILE_POINTS}); no-op.`,
      );
    }
    const badProfile = rejectBadProfile(doc, 'extrude_profile', profile);
    if (badProfile) return badProfile;
    if (depth <= 0) {
      return noop(
        doc,
        `extrude_profile: depth must be a finite number > 0 (got ${String(depth)}); no-op.`,
      );
    }
    const id = nextId('ext');
    const entity = newEntity('extrusion', id, { profile, depth }, position, color, {
      rotation: finiteVec3OrZero(rotation),
    });
    return commitSolid(doc, entity, `Extruded a ${profile.length}-point profile by ${depth}`);
  },
});

/**
 * @command move_entity
 * @pure
 * @layer core/commands
 * @affects translates 1 entity: position += delta; affected = [id]
 * @invariant only position changes; delta is in document units
 * @failure missing id -> no-op, affected:[]
 */
export const move = defineCommand({
  name: 'move_entity',
  description:
    'Translate one entity by a relative [dx, dy, dz] vector in document units (see set_units); ' +
    'its position becomes position + delta and its rotation/geometry are unchanged. ' +
    'Right-handed frame, +Z up; works on 2D shapes and 3D solids alike. ' +
    'If the id does not exist the document is left unchanged and nothing is affected.',
  params: z.object({
    id: z.string().describe('Target entity id'),
    delta: vec3(
      'Relative translation [dx, dy, dz] in document units, e.g. [10, 0, 0] moves +X by 10.',
    ),
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

    const { document, dissolvedGroups, prunedReferences } = withoutEntities(doc, new Set([id]));

    const dissolveSuffix =
      dissolvedGroups.length > 0
        ? ` Dissolved group(s): [${dissolvedGroups.join(', ')}] (fell below 2 members).`
        : '';

    return {
      document,
      summary: `Deleted ${id}.${dissolveSuffix}${referenceSuffix(prunedReferences)}`,
      affected: [id],
    };
  },
});
