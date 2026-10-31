/** emboss_on_face — raise, sink, scribe or engrave 2D profiles (and font text) on a plane, cylinder, cone, sphere or torus face (03 WRP M3 - M5). */

import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { runEmboss } from './embossRun';
import { faceRefField, placementField } from './schemas';

const MAX_PROFILES = 500;

/** The parameters of emboss_on_face (shared by its read-only preview). */
export const embossParams = z.object({
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
  chain: z
    .array(faceRefField)
    .max(15)
    .optional()
    .describe(
      'Multi-face emboss: more faces (plane, cylinder, cone, sphere or torus) adjacent to `face`, each sharing an edge with the faces before it, e.g. a cylinder and its tangent planes. The faces are unfolded into one chart (develop, no stretch, for plane, cylinder, cone; sphere and torus faces use placement.method geodesic, the join mismatch and the stretch are measured and refused above maxLengthStrain with WRP_DISTORTION_EXCEEDED), the sketch is cut at the shared edges and each part is embossed on its own face in one exact result. The shared edges must develop to straight lines (generatrices of cylinders, rulings of cones, straight plane edges: WRP_CHAIN_EDGE_CURVED otherwise) and, for emboss / deboss, be smooth (tangent faces) or a straight edge between two plane faces, where the corner is mitred: a prism along the edge is united (emboss on a convex edge) or subtracted (deboss on a concave edge) over the stretches the sketch covers, and the outline must cross it at right angles (data.mitre; WRP_CHAIN_EDGE_SHARP for any other sharp edge or crossing; scribe crosses sharp edges). data.faces lists the part on each face, data.expectedVolumeDelta is the sum of the closed forms.',
    ),
  walls: z
    .enum(['normal', 'pull'])
    .optional()
    .describe(
      'Wall form of emboss and deboss. normal (default): walls normal to the face. pull: walls parallel to pullDirection (the form a mould can release), the relief being the region prism along the pull cut to the layer between the face and its offset by depth; needs pullDirection, works on plane, cylinder, cone and sphere faces, emboss and deboss only.',
    ),
  pullDirection: z
    .tuple([z.number(), z.number(), z.number()])
    .optional()
    .describe(
      'walls pull only: direction [x, y, z] the mould opens along (world, not necessarily unit; its sign does not matter). It must cross the face at every point of the region (WRP_PULL_PARALLEL when it runs along the face).',
    ),
  draftDeg: z
    .number()
    .optional()
    .describe(
      'walls pull only: draft angle of the walls in degrees, [0, 45). The relief narrows away from the face (an emboss toward its top, a deboss toward its floor) by tan(draft) per unit of height, hinged on the plane through the placement anchor perpendicular to the pull (the tangent plane only when the pull is the face normal); the drafted base grows past the sketch footprint (data.draftBaseGrowth) and an oblique pull shifts the relief sideways (data.obliqueShift). A draft that closes the thinnest place of the region refuses with WRP_DRAFT_CLOSES (data.maxDraftDeg).',
    ),
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
});

/**
 * @affects replaces the solid by a kernel result (a new mesh entity carrying the exact recipe); the profiles stay
 * @invariant develop is an isometry: the footprint on the face has the area of the profile (data.regionArea) and the volume change follows the closed form of data.expectedVolumeDelta
 *   (plane A d, cylinder A d (1 +- d / 2r), cone A d +- (d^2 / 2) cos(alpha) A_uv, sphere A (d +- d^2 / R + d^3 / 3R^2), torus by the tube-offset integral); walls are normal to the face, or with walls pull parallel to pullDirection and tilted by draftDeg (no closed form on a curved face or with a draft: data.expectedVolumeDelta is null; the footprint is fitted within fitTolerance, data.footprintDeviation, and data.exact is false above 0); (a freeform face: parallel to the outward normal at the anchor, the top is the exact offset of the face); the result is a valid
 *   closed exact solid or nothing changes; engrave is a deboss of the area swept by a tool of toolWidth along the outline paths (polygonal boundary, data.exact false)
 * @failure open profile (emboss / deboss / scribe), self-intersection, depth <= 0, engrave without toolWidth, depth reaching the axis (a cut on a convex face), wrap beyond one turn, region leaving the face,
 *   sphere, torus or freeform face with develop, freeform face without a kernel B-spline, scribe on a freeform face, fold of a freeform geodesic chart, a face the pull sees edge-on, walls pull on a freeform face, a pull along the face (WRP_PULL_PARALLEL) or a draft that closes the thinnest place of the region (WRP_DRAFT_CLOSES, data.maxDraftDeg), stretch of a geodesic / parametric chart above the limit, kernel failure -> coded no-op
 */
export const embossOnFace = defineCommand({
  name: 'emboss_on_face',
  description:
    'Emboss (raise), deboss (sink), scribe (split the face along) or engrave (cut a groove along) 2D profiles on a plane, cylinder, cone, sphere or torus face of a solid: the profiles are wrapped onto the face keeping every ' +
    'length (method develop on plane, cylinder, cone) or by the geodesic / parametric chart of a sphere or torus (stretch measured and held to maxLengthStrain), lifted along the face normal by `depth` (document units; emboss adds material outside the face, deboss removes it inside), and fused or cut ' +
    'exactly; the walls are normal to the face unless `walls` is "pull" (parallel to `pullDirection`, tilted by `draftDeg`; a pull along the face refuses with WRP_PULL_PARALLEL, a draft that closes the thinnest place with WRP_DRAFT_CLOSES and data.maxDraftDeg; expectedVolumeDelta is then null off a plane and data.footprintDeviation reports the fit of the walls). `profileIds` are closed sketch shapes (rectangle, circle, ellipse, closed polyline / spline) or text created with a font ' +
    '(holes of O, B ... are kept). `placement` anchors a sketch point on a face point, turns and may mirror the sketch (see wrap_to_face). scribe needs no depth and keeps ' +
    'the volume: the face is only split along the profile outlines (faces + 1 per closed profile). engrave takes ANY profile (open curves, closed shapes, single-line text such as font "LLULL Single Line"): a flat tool of ' +
    '`toolWidth` with round ends is swept along the outline paths and the swept area is cut `depth` deep (a closed shape gets a groove along its contour, not a pocket). The result replaces the solid and reports data: volumeDelta ' +
    '(exact, document units cubed), expectedVolumeDelta (closed form: plane A d; cylinder A d (1 +- d / 2r); cone A d +- (d^2 / 2) cos(alpha) A_uv; sphere A (d +- d^2 / R + d^3 / 3R^2)), regionArea, regions, ' +
    'angularSpanRad, distortion, unverified (font not pinned) and provenance. A sketch wider than one turn refuses with WRP_WRAP_OVERLAP, a region leaving the face with ' +
    'WRP_OUTSIDE_FACE, a cut as deep as the radius with WRP_DEPTH_EXCEEDS_SOLID, an open profile (not engrave) with WRP_PROFILE_OPEN, a sphere or torus with method develop with ' +
    'WRP_FACE_NOT_DEVELOPABLE, a stretch above the limit with WRP_DISTORTION_EXCEEDED. A freeform (B-spline) face works with method geodesic or parametric (develop refuses with WRP_FACE_NOT_DEVELOPABLE) and modes emboss, deboss and engrave: the sketch is charted on the exact surface, the walls run parallel to the outward normal at the anchor (not normal to the face; data.freeform.pullDirection), the top of the relief is the exact offset of the face by depth, so the relief is built from exact booleans (data.exact false, data.freeform.footprintDeviation = fit of the footprint outline); a fold of the geodesic chart refuses with WRP_CHART_FOLD (the chart is valid up to the first conjugate point; a cut-locus overlap before it is not detected), a deboss deeper than the material with WRP_DEPTH_EXCEEDS_SOLID (data.maxDepth), a periodic B-spline is charted as a strip (WRP_OUTSIDE_FACE at the seam), a face the pull sees edge-on or from both sides over the region with WRP_FACE_TOO_STEEP, scribe and a kernel with no B-spline for the face with WRP_METHOD_UNAVAILABLE. Needs the exact (native) kernel. Next: check_wrap, mass_properties, render_view.',
  params: embossParams,
  annotations: { requiresKernel: true, previewQuery: 'preview_emboss_on_face' },
  run: (doc, params, ctx): CommandResult => runEmboss(doc, ctx, 'emboss_on_face', params),
});
