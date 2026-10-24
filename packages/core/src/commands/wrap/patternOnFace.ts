/** pattern_on_face — a seed profile repeated on a rectangular lattice of the sketch and embossed, debossed or scribed in one exact operation (03 WRP M5). */

import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { runEmboss } from './embossRun';
import { faceRefField, placementField } from './schemas';

const MAX_PROFILES = 100;
const MAX_COUNT = 200;

/**
 * @affects replaces the solid by a kernel result (a new mesh entity carrying the exact recipe); the seed profiles stay
 * @invariant instance (i, j) is the seed moved by (i pitchX, j pitchY) in the sketch frame, wrapped by the same chart as the seed; every instance lies wholly on the face and instances do not overlap
 * @failure pitch smaller than the seed extent, an instance leaving the face, more than 2000 instances, the refusals of emboss_on_face -> coded no-op
 */
export const patternOnFace = defineCommand({
  name: 'pattern_on_face',
  description:
    'Repeat seed profiles on a rectangular lattice and emboss, deboss or scribe all copies on a face in ONE exact operation (a perforation grid, a row of dimples, studs on a grip). ' +
    '`seedProfileIds` are closed 2D shapes (or texts with a font) in the sketch; `grid` { countX, countY, pitchX, pitchY } gives the number of copies along the sketch x and y axes ' +
    'and the distance between copy origins, in sketch (chart) document units (on a cylinder x runs round the circumference, y along the axis; lengths are kept). `placement` puts the seed ' +
    '(copy 0, 0) on the face like emboss_on_face. Copy (i, j) is the seed moved by (i pitchX, j pitchY). Everything else is emboss_on_face: mode emboss | deboss | scribe, depth, ' +
    'maxLengthStrain, fitTolerance, the closed forms, the data (plus data.instances and data.grid). A pitch smaller than the seed extent refuses with WRP_PATTERN_OVERLAP, a copy leaving ' +
    'the face with WRP_OUTSIDE_FACE (nothing is cut). Needs the exact (native) kernel. Next: check_wrap, mass_properties.',
  params: z.object({
    id: z.string().describe('Id of the solid.'),
    face: faceRefField,
    seedProfileIds: z
      .array(z.string())
      .min(1)
      .max(MAX_PROFILES)
      .describe('Ids of the closed 2D profiles (or font texts) repeated by the pattern.'),
    mode: z
      .enum(['emboss', 'deboss', 'scribe'])
      .describe('emboss: material added; deboss: material removed; scribe: the face is split along every copy, no material change.'),
    depth: z.number().optional().describe('Height of the emboss or depth of the deboss, document units, > 0. Not used by scribe.'),
    grid: z
      .object({
        countX: z.number().int().min(1).max(MAX_COUNT).describe('Copies along the sketch x axis (1..200).'),
        countY: z.number().int().min(1).max(MAX_COUNT).describe('Copies along the sketch y axis (1..200).'),
        pitchX: z
          .number()
          .positive()
          .describe('Distance between copy origins along x, sketch document units (> the seed width when countX > 1).'),
        pitchY: z
          .number()
          .positive()
          .describe('Distance between copy origins along y, sketch document units (> the seed height when countY > 1).'),
      })
      .describe('The lattice: counts and pitches in the sketch frame. At most 2000 copies in all.'),
    placement: placementField.optional(),
    maxLengthStrain: z
      .number()
      .positive()
      .optional()
      .describe('Largest accepted relative length change of the wrap (1 = 100 %). Default 0.02 (named default).'),
    fitTolerance: z
      .number()
      .positive()
      .optional()
      .describe('Largest deviation of a fitted pcurve from its exact image, document units. Default: 1e-6 x the solid diagonal.'),
  }),
  annotations: { requiresKernel: true },
  run: (doc, params, ctx): CommandResult =>
    runEmboss(doc, ctx, 'pattern_on_face', {
      id: params.id,
      face: params.face,
      profileIds: params.seedProfileIds,
      mode: params.mode,
      depth: params.depth,
      placement: params.placement,
      maxLengthStrain: params.maxLengthStrain,
      fitTolerance: params.fitTolerance,
      grid: params.grid,
    }),
});
