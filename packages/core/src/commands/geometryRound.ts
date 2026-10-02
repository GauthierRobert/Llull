import type { Entity } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3, tolerant } from './schema';
import { nextId } from '../lib/id';
import { rotatedEntityBounds } from './scene';
import { ORIGIN, resolveRotation, resolvePosition, boundsText, withEntity } from './geometryShared';
export const addCylinder = defineCommand({
  name: 'add_cylinder',
  description:
    'Create a cylinder solid. Right-handed world frame, +Z up. ' +
    'radius and height must both be > 0. ' +
    'anchor controls which point the position refers to: ' +
    '"center" (default) = geometric center (cylinder spans ±height/2 about stored position along its axis); ' +
    '"min" = min-XYZ corner of the AABB; ' +
    '"base-center" = center of the bottom face (mid X/Y, min Z of AABB). ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
  params: z.object({
    radius: z
      .number()
      .describe('Radius of the cylinder cross-section in document units. Must be > 0.'),
    height: z.number().describe('Total height of the cylinder in document units. Must be > 0.'),
    position: looseVec3(
      'World-space location of the anchor point [x, y, z] in document units. ' +
        'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
    ).optional(),
    anchor: tolerant(
      z
        .enum(['center', 'min', 'base-center'])
        .describe(
          'Which point on the cylinder the position refers to. ' +
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
  run: (
    doc,
    { radius, height, position = ORIGIN, rotation, color = '#6b8f9c', anchor },
  ): CommandResult => {
    if (!Number.isFinite(radius) || radius <= 0) {
      return {
        document: doc,
        summary: `add_cylinder failed: radius must be finite and > 0, got ${radius}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(height) || height <= 0) {
      return {
        document: doc,
        summary: `add_cylinder failed: height must be finite and > 0, got ${height}.`,
        affected: [],
      };
    }
    // Default anchor for cylinder is 'center': stored position is the geometric center.
    // AABB half-extents from center: [radius, radius, height/2] (axis along +Z).
    const storedPosition = resolvePosition(
      [radius, radius, height / 2],
      'center',
      anchor,
      position,
    );
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
});

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

export const addSphere = defineCommand({
  name: 'add_sphere',
  description:
    'Create a sphere solid. Right-handed world frame, +Z up. ' +
    'radius must be > 0. rotation is accepted and stored for uniformity but is geometrically moot. ' +
    'anchor controls which point the position refers to: ' +
    '"center" (default) = geometric center; "min" = min-XYZ corner of the AABB; ' +
    '"base-center" = center of the bottom face (mid X/Y, min Z). ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
  params: z.object({
    radius: z.number().describe('Radius of the sphere in document units. Must be > 0.'),
    position: looseVec3(
      'World-space location of the anchor point [x, y, z] in document units. ' +
        'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
    ).optional(),
    anchor: tolerant(
      z
        .enum(['center', 'min', 'base-center'])
        .describe(
          'Which point on the sphere the position refers to. ' +
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
          'Stored for uniformity; geometrically moot for a sphere. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
      ),
    ).optional(),
    color: z
      .string()
      .describe('Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".')
      .optional(),
  }),
  run: (doc, { radius, position = ORIGIN, rotation, color = '#6b8f9c', anchor }): CommandResult => {
    if (!Number.isFinite(radius) || radius <= 0) {
      return {
        document: doc,
        summary: `add_sphere failed: radius must be finite and > 0, got ${radius}.`,
        affected: [],
      };
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
});

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

export const addCone = defineCommand({
  name: 'add_cone',
  description:
    'Create a cone solid. Right-handed world frame, +Z up. ' +
    'radius and height must both be > 0. ' +
    'anchor controls which point the position refers to: ' +
    '"base-center" (default) = center of the circular base (the apex is at position + [0,0,height]); ' +
    '"center" = geometric center of the AABB; ' +
    '"min" = min-XYZ corner of the AABB. ' +
    'The anchor offset is applied in the local UNROTATED frame; rotation is then applied by the viewport about the stored origin.',
  params: z.object({
    radius: z.number().describe('Radius of the circular base in document units. Must be > 0.'),
    height: z
      .number()
      .describe(
        'Height from the base center to the apex along the local +Z axis in document units. Must be > 0.',
      ),
    position: looseVec3(
      'World-space location of the anchor point [x, y, z] in document units. ' +
        'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
    ).optional(),
    anchor: tolerant(
      z
        .enum(['center', 'min', 'base-center'])
        .describe(
          'Which point on the cone the position refers to. ' +
            '"base-center" (default): center of the circular base; apex at position+[0,0,height]. ' +
            '"center": geometric center of the AABB (mid X/Y/Z). ' +
            '"min": min-XYZ corner of the AABB. ' +
            'Unknown values fall back to "base-center". ' +
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
  run: (
    doc,
    { radius, height, position = ORIGIN, rotation, color = '#6b8f9c', anchor },
  ): CommandResult => {
    if (!Number.isFinite(radius) || radius <= 0) {
      return {
        document: doc,
        summary: `add_cone failed: radius must be finite and > 0, got ${radius}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(height) || height <= 0) {
      return {
        document: doc,
        summary: `add_cone failed: height must be finite and > 0, got ${height}.`,
        affected: [],
      };
    }
    // Default anchor for cone is 'base-center': stored position IS the base center.
    // AABB from base-center origin: spans [−radius..+radius, −radius..+radius, 0..height].
    // To use resolvePosition (which works from center), we express the base-center origin
    // relative to the AABB center: AABB center is at [0, 0, height/2] from base-center.
    // We pass half-extents as seen from the AABB center: [radius, radius, height/2].
    // defaultAnchor='base-center' tells resolvePosition the stored origin is the base-center.
    const storedPosition = resolvePosition(
      [radius, radius, height / 2],
      'base-center',
      anchor,
      position,
    );
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
});

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

export const addTorus = defineCommand({
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
  params: z.object({
    ringRadius: z
      .number()
      .describe(
        'Distance from the torus center to the center of the tube (major radius) in document units. Must be > 0.',
      ),
    tubeRadius: z
      .number()
      .describe(
        'Radius of the circular tube cross-section (minor radius) in document units. Must be > 0. ' +
          'Should be less than ringRadius for a non-self-intersecting torus.',
      ),
    position: looseVec3(
      'World-space location of the anchor point [x, y, z] in document units. ' +
        'Right-handed frame, +Z up. The ring lies in the XY plane. Defaults to [0, 0, 0].',
    ).optional(),
    anchor: tolerant(
      z
        .enum(['center', 'min', 'base-center'])
        .describe(
          'Which point on the torus the position refers to. ' +
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
  run: (
    doc,
    { ringRadius, tubeRadius, position = ORIGIN, rotation, color = '#6b8f9c', anchor },
  ): CommandResult => {
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
    const storedPosition = resolvePosition(
      [outerRadius, outerRadius, tubeRadius],
      'center',
      anchor,
      position,
    );
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
});

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
