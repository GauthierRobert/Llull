/** render_view `clouds` (plant 10 SCN-M3c): the request schema and the cut predicate handed to the `clouds` overlay of the scan plugin. */

import type { Vec3 } from '../../model/types';
import { dot3 } from '../../lib/vec3';
import { z } from '../schema';
import { isValidCut, unitPlanes } from './clip';
import type { CutSpec } from './types';

export const cloudParams = {
  clouds: z
    .object({
      maxPoints: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Total point budget over all attached clouds, clamped to [100, 200000]. Default 20000.'),
      colour: z
        .enum(['elevation', 'rgb', 'intensity', 'classification'])
        .optional()
        .describe(
          'Point colour: "elevation" (default, viridis over the drawn height range), or the stored "rgb", "intensity" (grey) or "classification" (ASPRS palette); ' +
            'a cloud without that column falls back to elevation (named in data.clouds).',
        ),
      pointSizePx: z.number().positive().optional().describe('Mark diameter in pixels, clamped to [1, 8]. Default 2.'),
    })
    .optional()
    .describe(
      'Draw the attached point clouds (scan plugin) as small marks over the picture, projected like the solids (orthographic views only; not occluded by solids). ' +
        'Each cloud is read through the host point-cloud port at a deterministic level of detail within `maxPoints` (placement / registration applied), cropped by set_scan_crop boxes, ' +
        'the section box and `cut`, and dimmed under review shading. Without a port nothing is drawn and the summary says so. data.clouds reports the counts per cloud. ' +
        'The view is framed by the document entities: a scene of clouds only should also hold a box or section box that frames the area.',
    ),
};

/** The predicate "this world point survives the cut" of `cut` (every solid cut: a cut limited to entity ids does not touch clouds); undefined = no cut. */
export function cutKeep(cut: CutSpec | undefined): ((p: Vec3) => boolean) | undefined {
  if (cut === undefined || cut.entityIds !== undefined || !isValidCut(cut)) return undefined;
  const planes = unitPlanes(cut);
  return (p) => {
    const removed = planes.map((plane) => dot3(plane.normal, p) > plane.offset);
    return !(cut.mode === 'union' ? removed.some(Boolean) : removed.every(Boolean));
  };
}
