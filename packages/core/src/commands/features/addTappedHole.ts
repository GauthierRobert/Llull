/** add_tapped_hole (SC-F2): ISO metric tapped holes M3-M20 = a minor-diameter bore with the modelled internal thread, via add_hole. */

import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { currentContext } from '../context';
import { execute } from '../execute';
import { fromMm } from '../../model/units';
import { isoBasicDiameters, parseIsoMetric } from '../../lib/threadForm';
import { POINT_FRAMES } from './facePoints';
import { extentParams } from './holeSpec';
import { refuse } from './ftr';
import { sketchPointsSchema } from './sketchPoints';

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * @affects replaces `target` by 1 mesh entity: the part with tapped holes (a feature(hole) node with a modelled thread), like add_hole
 * @invariant bore diameter = ISO 68-1 basic minor diameter d1 = d - 1.082532 P; thread = basic 60 degree profile, coarse ISO 261 pitch unless "MdxP" is given
 * @failure designation not ISO metric M3-M20, size without a coarse pitch and no explicit pitch, plus every add_hole refusal (face, points, extent, kernel)
 *   -> rejected no-op
 */
export const addTappedHole = defineCommand({
  name: 'add_tapped_hole',
  annotations: { requiresKernel: true },
  description:
    'Drill ISO metric TAPPED holes (modelled internal thread) into a planar face of a 3D solid: a bore at the basic minor diameter ' +
    'd1 = d - 1.082532 P plus a real helical thread groove of the ISO 68-1 basic profile (H = 0.866025 P, pitch diameter d2 = d - 0.649519 P). ' +
    'size is "M8" (coarse pitch of ISO 261: M3 0.5, M4 0.7, M5 0.8, M6 1, M8 1.25, M10 1.5, M12 1.75, M14 2, M16 2, M18 2.5, M20 2.5) or ' +
    '"M8x1" (explicit/fine pitch); only M3-M20 are supported (anything else is refused). The face, points (including points taken from ' +
    'sketch points) and extent work exactly as in add_hole (through_all or blind; a blind thread length defaults to the full depth, thread.depth ' +
    'shortens it). Sizes are in mm in the designation; the geometry is created in the document unit. The result and refusals are those of add_hole ' +
    '(codes FTR_*); data = { designation, pitch, majorDiameter, pitchDiameter, minorDiameter } in document units.',
  params: z.object({
    target: z.string().describe('Id of the 3D solid to tap (a primitive or a kernel result).'),
    face: z
      .object({ near: vec3('World point [x, y, z] on (or within 0.1% of the part size of) the planar face, in document length units.') })
      .describe('The planar face to drill into, picked by a world point.'),
    points: z
      .union([z.array(z.array(z.number())).min(1), sketchPointsSchema])
      .describe(
        'Hole centres: a list ([u, v] face frame by default, see pointsFrame) or { sketchEntityIds?, pointRefs? } from sketch points, as in add_hole.',
      ),
    pointsFrame: z
      .enum(POINT_FRAMES)
      .optional()
      .describe('Coordinates of a points list: "face" (default), "world_xy" or "world" (see add_hole).'),
    size: z.string().describe('ISO metric size: "M8" (coarse pitch) or "M8x1" (explicit pitch). M3-M20 only.'),
    extent: extentParams,
    threadDepth: z
      .number()
      .positive()
      .optional()
      .describe('Threaded depth from the face, in document length units. Omit for the full hole depth.'),
    handedness: z.enum(['right', 'left']).optional().describe('"right" (default) or "left" thread.'),
  }),
  run: (doc, { target, face, points, pointsFrame, size, extent, threadDepth, handedness }, ctx): CommandResult => {
    const iso = parseIsoMetric(size);
    if (typeof iso === 'string')
      return refuse(doc, 'add_tapped_hole', 'FTR_THREAD_DESIGNATION_INVALID', iso, 'use M3..M20, e.g. M6 or M6x0.75', [target], ['size']);
    const major = fromMm(doc, iso.majorDiameterMm);
    const pitch = fromMm(doc, iso.pitchMm);
    const basic = isoBasicDiameters(major, pitch);
    const hole = {
      kind: 'simple',
      diameter: basic.minorDiameter,
      thread: {
        designation: iso.designation,
        family: 'M',
        modelled: true,
        ...(threadDepth === undefined ? {} : { depth: threadDepth }),
        ...(handedness === undefined ? {} : { handedness }),
      },
    };
    const inner = execute(
      doc,
      'add_hole',
      { target, face, points, ...(pointsFrame === undefined ? {} : { pointsFrame }), hole, extent },
      ctx ?? currentContext(),
    );
    const summary = `add_tapped_hole: ${iso.designation}${iso.coarse ? ' (coarse)' : ''} d1 Ø${round(basic.minorDiameter)}, d2 Ø${round(basic.pitchDiameter)} — ${inner.summary}`;
    if (inner.affected.length === 0) return { ...inner, summary };
    const data = {
      designation: iso.designation,
      pitch,
      majorDiameter: major,
      pitchDiameter: basic.pitchDiameter,
      minorDiameter: basic.minorDiameter,
    };
    return { ...inner, summary, data };
  },
});
