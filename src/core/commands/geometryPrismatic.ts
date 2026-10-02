import type { Entity } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3, tolerant } from './schema';
import { nextId } from '../../lib/id';
import { rotatedEntityBounds } from './scene';
import { ORIGIN, resolveRotation, resolvePosition, boundsText, withEntity } from './geometryShared';
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
    position: looseVec3(
      'World-space location of the anchor point [x, y, z] in document units. ' +
        'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
    ).optional(),
    anchor: tolerant(
      z
        .enum(['center', 'min', 'base-center'])
        .describe(
          'Which point on the wedge the position refers to. ' +
            '"min" (default): lower-front-left corner of the bounding box (min-XYZ). ' +
            '"center": geometric center of the AABB. ' +
            '"base-center": center of the bottom face (mid X/Y, min Z). ' +
            'Unknown values fall back to "min". ' +
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
        summary: `add_wedge failed: all size components must be finite and > 0, got [${size.join(', ')}].`,
        affected: [],
      };
    }
    // Default anchor for wedge is 'min': stored position is the lower-front-left (min-XYZ) corner.
    // AABB half-extents from min corner: [w/2, h/2, d/2] (half-extents measured from min = stored origin).
    const storedPosition = resolvePosition([w / 2, h / 2, d / 2], 'min', anchor, position);
    const id = nextId('wdg');
    const entity: Entity = {
      id,
      kind: 'wedge',
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
      summary: `Added wedge ${id} of size ${size.join('×')}; ${boundsText(b)}.`,
      affected: [id],
    };
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
    position: looseVec3(
      'World-space location of the anchor point [x, y, z] in document units. ' +
        'Right-handed frame, +Z up. Defaults to [0, 0, 0].',
    ).optional(),
    anchor: tolerant(
      z
        .enum(['center', 'min', 'base-center'])
        .describe(
          'Which point on the pyramid the position refers to. ' +
            '"base-center" (default): center of the rectangular base; apex at position+[0,0,height]. ' +
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
    { baseWidth, baseDepth, height, position = ORIGIN, rotation, color = '#6b8f9c', anchor },
  ): CommandResult => {
    if (!Number.isFinite(baseWidth) || baseWidth <= 0) {
      return {
        document: doc,
        summary: `add_pyramid failed: baseWidth must be finite and > 0, got ${baseWidth}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(baseDepth) || baseDepth <= 0) {
      return {
        document: doc,
        summary: `add_pyramid failed: baseDepth must be finite and > 0, got ${baseDepth}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(height) || height <= 0) {
      return {
        document: doc,
        summary: `add_pyramid failed: height must be finite and > 0, got ${height}.`,
        affected: [],
      };
    }
    // Default anchor for pyramid is 'base-center': stored position IS the base center.
    // AABB from base-center origin: spans [−bw/2..+bw/2, −bd/2..+bd/2, 0..height].
    // Half-extents for resolvePosition (which works from AABB center internally):
    // pass half-extents as seen from base-center: [baseWidth/2, baseDepth/2, height/2].
    const storedPosition = resolvePosition(
      [baseWidth / 2, baseDepth / 2, height / 2],
      'base-center',
      anchor,
      position,
    );
    const id = nextId('pyr');
    const entity: Entity = {
      id,
      kind: 'pyramid',
      baseWidth,
      baseDepth,
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
      summary: `Added pyramid ${id} with base ${baseWidth}×${baseDepth} and height ${height}; ${boundsText(b)}.`,
      affected: [id],
    };
  },
});
