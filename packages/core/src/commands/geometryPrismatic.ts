import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 } from './schema';
import { ORIGIN } from '../lib/vec3';
import {
  DEFAULT_SOLID_COLOR,
  placeSolid,
  placedSolidFields,
  rejectBadSize,
  rejectNonPositive,
} from './geometryShared';

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

export const addWedge = defineCommand({
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
  params: z.object({
    size: looseVec3(
      '[width, height, depth] in document units. width=X extent; height=full height at front face; ' +
        'depth=Z extent (ramp direction). All must be > 0.',
    ),
    ...placedSolidFields('wedge', 'min', {
      min: 'lower-front-left corner of the bounding box (min-XYZ)',
      center: 'geometric center of the AABB',
    }),
  }),
  run: (
    doc,
    { size, position = ORIGIN, rotation, color = DEFAULT_SOLID_COLOR, anchor },
  ): CommandResult => {
    const rejected = rejectBadSize(doc, 'add_wedge', size);
    if (rejected) return rejected;
    const [w, h, d] = size;
    return placeSolid(doc, {
      kind: 'wedge',
      idPrefix: 'wdg',
      geometry: { size },
      halfExtents: [w / 2, h / 2, d / 2],
      defaultAnchor: 'min',
      anchor,
      position,
      rotation,
      color,
      describe: (id) => `Added wedge ${id} of size ${size.join('×')}`,
    });
  },
});

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

export const addPyramid = defineCommand({
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
  params: z.object({
    baseWidth: z
      .number()
      .describe('Full width of the rectangular base along X in document units. Must be > 0.'),
    baseDepth: z
      .number()
      .describe('Full depth of the rectangular base along Y in document units. Must be > 0.'),
    height: z
      .number()
      .describe(
        'Height from the base center to the apex along the local +Z axis in document units. Must be > 0.',
      ),
    ...placedSolidFields('pyramid', 'base-center', {
      'base-center': 'center of the rectangular base; apex at position+[0,0,height]',
      center: 'geometric center of the AABB (mid X/Y/Z)',
    }),
  }),
  run: (
    doc,
    {
      baseWidth,
      baseDepth,
      height,
      position = ORIGIN,
      rotation,
      color = DEFAULT_SOLID_COLOR,
      anchor,
    },
  ): CommandResult => {
    const rejected = rejectNonPositive(doc, 'add_pyramid', [
      ['baseWidth', baseWidth],
      ['baseDepth', baseDepth],
      ['height', height],
    ]);
    if (rejected) return rejected;
    return placeSolid(doc, {
      kind: 'pyramid',
      idPrefix: 'pyr',
      geometry: { baseWidth, baseDepth, height },
      halfExtents: [baseWidth / 2, baseDepth / 2, height / 2],
      defaultAnchor: 'base-center',
      anchor,
      position,
      rotation,
      color,
      describe: (id) =>
        `Added pyramid ${id} with base ${baseWidth}×${baseDepth} and height ${height}`,
    });
  },
});
