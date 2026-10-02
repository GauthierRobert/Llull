import type { Entity, EntityGroup } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3, tolerant, untypedArray } from './schema';
import { nextId } from '../../lib/id';
import { rotatedEntityBounds } from './scene';
import { ORIGIN, resolveRotation, resolvePosition, boundsText, withEntity } from './geometryShared';
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
    position: looseVec3(
      'World-space location of the anchor point [x, y, z] in document units. ' +
        'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
    ).optional(),
    anchor: tolerant(
      z
        .enum(['center', 'min', 'base-center'])
        .describe(
          'Which point on the box the position refers to. ' +
            '"center" (default): geometric center. ' +
            '"min": min-XYZ corner of the AABB. ' +
            '"base-center": center of the bottom face (mid X/Y, min Z). ' +
            'Unknown values fall back to "center". ' +
            'Offset is applied in the local UNROTATED frame; viewport rotates about the stored origin.',
        ),
    ).optional(),
    rotation: tolerant(
      looseVec3(
        'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
      ),
    ).optional(),
    color: z
      .string()
      .describe('Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".')
      .optional(),
  }),
  run: (doc, { size, position = ORIGIN, rotation, color = '#6b8f9c', anchor }): CommandResult => {
    const [w, h, d] = size;
    if (
      !Number.isFinite(w) ||
      !Number.isFinite(h) ||
      !Number.isFinite(d) ||
      w <= 0 ||
      h <= 0 ||
      d <= 0
    ) {
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
    rotation: tolerant(
      looseVec3(
        'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
      ),
    ).optional(),
    color: z
      .string()
      .describe('Hex color string, e.g. "#c8553d". Defaults to "#c8553d".')
      .optional(),
  }),
  run: (doc, { profile, depth, position = ORIGIN, rotation, color = '#c8553d' }): CommandResult => {
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
});

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
});
