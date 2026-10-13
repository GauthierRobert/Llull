import type { CommandResult } from '../types';
import { defineCommand, z, looseVec3 } from '../schema';
import { DEFAULT_SOLID_COLOR, placeSizedSolid, placedSolidFields } from './shared';
import { ORIGIN } from '../../lib/vec3';

/**
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
    ...placedSolidFields('box', 'center'),
  }),
  run: (doc, { size, position = ORIGIN, rotation, color = DEFAULT_SOLID_COLOR, anchor }): CommandResult => {
    return placeSizedSolid(doc, 'box', 'box', 'center', size, {
      position,
      rotation,
      color,
      anchor,
    });
  },
});
