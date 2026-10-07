import type { CommandResult } from './types';
import { defineCommand, z, colorField } from './schema';
import { ORIGIN } from '../lib/vec3';
import {
  DEFAULT_SOLID_COLOR,
  anchorField,
  placeSolid,
  positionField,
  rejectNonPositive,
  rotationField,
} from './geometryShared';

/**
 * @command add_cylinder
 * @pure
 * @layer core/commands
 * @affects creates 1 cylinder entity; stored position is the geometric center of the cylinder
 * @invariant radius > 0; height > 0
 * @failure radius <= 0 or height <= 0 -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 * @failure unknown anchor value -> falls back to default anchor 'center', no throw
 */

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
    position: positionField(),
    anchor: anchorField('cylinder', 'center'),
    rotation: rotationField(),
    color: colorField(DEFAULT_SOLID_COLOR),
  }),
  run: (
    doc,
    { radius, height, position = ORIGIN, rotation, color = DEFAULT_SOLID_COLOR, anchor },
  ): CommandResult => {
    const rejected = rejectNonPositive(doc, 'add_cylinder', [
      ['radius', radius],
      ['height', height],
    ]);
    if (rejected) return rejected;
    return placeSolid(doc, {
      kind: 'cylinder',
      idPrefix: 'cyl',
      geometry: { radius, height },
      halfExtents: [radius, radius, height / 2],
      defaultAnchor: 'center',
      anchor,
      position,
      rotation,
      color,
      describe: (id) => `Added cylinder ${id} with radius ${radius} and height ${height}`,
    });
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
    position: positionField(),
    anchor: anchorField('sphere', 'center'),
    rotation: rotationField('Stored for uniformity; geometrically moot for a sphere.'),
    color: colorField(DEFAULT_SOLID_COLOR),
  }),
  run: (
    doc,
    { radius, position = ORIGIN, rotation, color = DEFAULT_SOLID_COLOR, anchor },
  ): CommandResult => {
    const rejected = rejectNonPositive(doc, 'add_sphere', [['radius', radius]]);
    if (rejected) return rejected;
    return placeSolid(doc, {
      kind: 'sphere',
      idPrefix: 'sph',
      geometry: { radius },
      halfExtents: [radius, radius, radius],
      defaultAnchor: 'center',
      anchor,
      position,
      rotation,
      color,
      describe: (id) => `Added sphere ${id} with radius ${radius}`,
    });
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
    position: positionField(),
    anchor: anchorField('cone', 'base-center', {
      'base-center': 'center of the circular base; apex at position+[0,0,height]',
      center: 'geometric center of the AABB (mid X/Y/Z)',
    }),
    rotation: rotationField(),
    color: colorField(DEFAULT_SOLID_COLOR),
  }),
  run: (
    doc,
    { radius, height, position = ORIGIN, rotation, color = DEFAULT_SOLID_COLOR, anchor },
  ): CommandResult => {
    const rejected = rejectNonPositive(doc, 'add_cone', [
      ['radius', radius],
      ['height', height],
    ]);
    if (rejected) return rejected;
    return placeSolid(doc, {
      kind: 'cone',
      idPrefix: 'cone',
      geometry: { radius, height },
      halfExtents: [radius, radius, height / 2],
      defaultAnchor: 'base-center',
      anchor,
      position,
      rotation,
      color,
      describe: (id) => `Added cone ${id} with base radius ${radius} and height ${height}`,
    });
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
    position: positionField('The ring lies in the XY plane. '),
    anchor: anchorField('torus', 'center'),
    rotation: rotationField(),
    color: colorField(DEFAULT_SOLID_COLOR),
  }),
  run: (
    doc,
    { ringRadius, tubeRadius, position = ORIGIN, rotation, color = DEFAULT_SOLID_COLOR, anchor },
  ): CommandResult => {
    const rejected = rejectNonPositive(doc, 'add_torus', [
      ['ringRadius', ringRadius],
      ['tubeRadius', tubeRadius],
    ]);
    if (rejected) return rejected;
    const outerRadius = ringRadius + tubeRadius;
    return placeSolid(doc, {
      kind: 'torus',
      idPrefix: 'tor',
      geometry: { ringRadius, tubeRadius },
      halfExtents: [outerRadius, outerRadius, tubeRadius],
      defaultAnchor: 'center',
      anchor,
      position,
      rotation,
      color,
      describe: (id) =>
        `Added torus ${id} with ringRadius ${ringRadius} and tubeRadius ${tubeRadius}`,
    });
  },
});
