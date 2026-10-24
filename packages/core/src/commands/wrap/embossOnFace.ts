/** emboss_on_face — raise, sink, scribe or engrave 2D profiles (and font text) on a plane, cylinder, cone, sphere or torus face (03 WRP M3 - M5). */

import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { runEmboss } from './embossRun';
import { faceRefField, placementField } from './schemas';

const MAX_PROFILES = 500;

/**
 * @affects replaces the solid by a kernel result (a new mesh entity carrying the exact recipe); the profiles stay
 * @invariant develop is an isometry: the footprint on the face has the area of the profile (data.regionArea) and the volume change follows the closed form of data.expectedVolumeDelta
 *   (plane A d, cylinder A d (1 +- d / 2r), cone A d +- (d^2 / 2) cos(alpha) A_uv, sphere A (d +- d^2 / R + d^3 / 3R^2), torus by the tube-offset integral); walls are normal to the face; the result is a valid
 *   closed exact solid or nothing changes; engrave is a deboss of the area swept by a tool of toolWidth along the outline paths (polygonal boundary, data.exact false)
 * @failure open profile (emboss / deboss / scribe), self-intersection, depth <= 0, engrave without toolWidth, depth reaching the axis (a cut on a convex face), wrap beyond one turn, region leaving the face,
 *   sphere or torus with develop, freeform face, stretch of a geodesic / parametric chart above the limit, kernel failure -> coded no-op
 */
export const embossOnFace = defineCommand({
  name: 'emboss_on_face',
  description:
    'Emboss (raise), deboss (sink), scribe (split the face along) or engrave (cut a groove along) 2D profiles on a plane, cylinder, cone, sphere or torus face of a solid: the profiles are wrapped onto the face keeping every ' +
    'length (method develop on plane, cylinder, cone) or by the geodesic / parametric chart of a sphere or torus (stretch measured and held to maxLengthStrain), lifted along the face normal by `depth` (document units; emboss adds material outside the face, deboss removes it inside), and fused or cut ' +
    'exactly; the walls are normal to the face. `profileIds` are closed sketch shapes (rectangle, circle, ellipse, closed polyline / spline) or text created with a font ' +
    '(holes of O, B ... are kept). `placement` anchors a sketch point on a face point, turns and may mirror the sketch (see wrap_to_face). scribe needs no depth and keeps ' +
    'the volume: the face is only split along the profile outlines (faces + 1 per closed profile). engrave takes ANY profile (open curves, closed shapes, single-line text such as font "LLULL Single Line"): a flat tool of ' +
    '`toolWidth` with round ends is swept along the outline paths and the swept area is cut `depth` deep (a closed shape gets a groove along its contour, not a pocket). The result replaces the solid and reports data: volumeDelta ' +
    '(exact, document units cubed), expectedVolumeDelta (closed form: plane A d; cylinder A d (1 +- d / 2r); cone A d +- (d^2 / 2) cos(alpha) A_uv; sphere A (d +- d^2 / R + d^3 / 3R^2)), regionArea, regions, ' +
    'angularSpanRad, distortion, unverified (font not pinned) and provenance. A sketch wider than one turn refuses with WRP_WRAP_OVERLAP, a region leaving the face with ' +
    'WRP_OUTSIDE_FACE, a cut as deep as the radius with WRP_DEPTH_EXCEEDS_SOLID, an open profile (not engrave) with WRP_PROFILE_OPEN, a sphere or torus with method develop with ' +
    'WRP_FACE_NOT_DEVELOPABLE, a stretch above the limit with WRP_DISTORTION_EXCEEDED, a freeform face with WRP_METHOD_UNAVAILABLE. Needs the exact (native) kernel. Next: check_wrap, mass_properties, render_view.',
  params: z.object({
    id: z.string().describe('Id of the solid to emboss.'),
    face: faceRefField,
    profileIds: z
      .array(z.string())
      .min(1)
      .max(MAX_PROFILES)
      .describe('Ids of the 2D profiles (or font texts) to emboss. Closed shapes for emboss, deboss, scribe; any curve for engrave.'),
    mode: z
      .enum(['emboss', 'deboss', 'scribe', 'engrave'])
      .describe(
        'emboss: material added outside the face; deboss: material removed inside it; scribe: the face is split along the outlines, no material change; engrave: a groove of width toolWidth is cut along the outline paths.',
      ),
    depth: z.number().optional().describe('Height of the emboss or depth of the deboss / groove, document units, > 0. Not used by scribe.'),
    toolWidth: z
      .number()
      .optional()
      .describe('engrave only: width of the flat tool, document units, > 0 (the groove is this wide with round ends).'),
    placement: placementField.optional(),
    maxLengthStrain: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest accepted relative length change of the wrap (1 = 100 %). Default 0.02 (named default); develop faces have none. Held to the measured stretch of a geodesic or parametric chart.',
      ),
    fitTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest deviation of a fitted pcurve from its exact image, document units. Default: 1e-6 x the solid diagonal (named default).',
      ),
  }),
  annotations: { requiresKernel: true },
  run: (doc, params, ctx): CommandResult => runEmboss(doc, ctx, 'emboss_on_face', params),
});
