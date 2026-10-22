/** emboss_on_face — raise, sink or scribe 2D profiles (and font text) on a plane, cylinder or cone face with exact lengths (03 WRP M3). */

import type { EmbossParams } from '../../model/wrap';
import type { ShapeRecipe, Vec2 } from '../../model/types';
import { selfIntersects } from '../../lib/polygon';
import { scale3 } from '../../lib/vec3';
import { embossClosedForm, regionsAreas } from '../../geometry/embossVolume';
import { sampleSegment, type PlaneSegment } from '../../geometry/planeSegments';
import { defineCommand, z } from '../schema';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { DEFAULT_MAX_LENGTH_STRAIN, MAX_LENGTH_STRAIN_SOURCE, namedDefault, wrapData } from './conventions';
import { SEWING_RATIO, MIN_FIT_TOLERANCE } from './constants';
import { defaultFitTolerance, isRejection, openFace, resolveChart, type FaceSession } from './faceSession';
import { faceRefField, placementField } from './schemas';
import { isSketchFailure, sketchOutline, type SketchOutline } from './sketchProfiles';
import { checkOnFace, checkWrapAround, isMappingFailure, mapOutlineRegions, probePoints } from './wrapMapping';

const MAX_PROFILES = 500;
const MAX_PROBES = 48;
const CROSS_CHECK_SAMPLES = 12;

/** Volume of the exact solid and of its source: the kernel's exact mass properties, else its analysis. */
export function kernelVolume(
  session: Pick<FaceSession, 'kernel'>,
  shape: Parameters<NonNullable<FaceSession['kernel']['massProperties']>>[0],
): number | null {
  const mass = session.kernel.massProperties?.(shape) ?? null;
  if (mass !== null) return mass.volume;
  return session.kernel.analyze?.(shape)?.volume ?? null;
}

const polygonOf = (chain: readonly PlaneSegment[]): Vec2[] =>
  chain.flatMap((piece) => sampleSegment(piece, piece.kind === 'line' ? 2 : CROSS_CHECK_SAMPLES).slice(0, -1));

/**
 * How deep a deboss can go before it passes through the material: the distance from the deepest point of the mapped profile to the axis (cylinder: its radius;
 * cone: the smallest v of the profile x sin(semi-angle)). A bore (material outside the face) and a plane have no such limit.
 */
function debossLimit(session: FaceSession, pieces: readonly (readonly PlaneSegment[])[], convex: boolean | null): number | null {
  if (convex === false) return null;
  if (session.surface.type === 'cylinder') return session.surface.radius;
  if (session.surface.type !== 'cone') return null;
  const smallestV = Math.min(...pieces.flat().flatMap((piece) => sampleSegment(piece, 9).map((p) => p[1])));
  return smallestV * Math.sin(session.surface.semiAngle);
}

/**
 * @affects replaces the solid by a kernel result (a new mesh entity carrying the exact recipe); the profiles stay
 * @invariant develop is an isometry: the footprint on the face has the area of the profile (data.regionArea) and the volume change follows the closed form of data.expectedVolumeDelta
 *   (plane A d, cylinder A d (1 +- d / 2r), cone A d +- (d^2 / 2) cos(alpha) A_uv); walls are normal to the face; the result is a valid exact solid or nothing changes
 * @failure open profile (emboss / deboss), self-intersection, depth <= 0, depth reaching the axis (deboss on a convex face), wrap beyond one turn, region leaving the face, sphere or freeform face, kernel failure ->
 *   coded no-op
 */
export const embossOnFace = defineCommand({
  name: 'emboss_on_face',
  description:
    'Emboss (raise), deboss (sink) or scribe (split the face along) closed 2D profiles on a plane, cylinder or cone face of a solid: the profiles are wrapped onto the face keeping every ' +
    'length (method develop), lifted along the face normal by `depth` (document units; emboss adds material outside the face, deboss removes it inside), and fused or cut ' +
    'exactly; the walls are normal to the face. `profileIds` are closed sketch shapes (rectangle, circle, ellipse, closed polyline / spline) or text created with a font ' +
    '(holes of O, B ... are kept). `placement` anchors a sketch point on a face point, turns and may mirror the sketch (see wrap_to_face). scribe needs no depth and keeps ' +
    'the volume: the face is only split along the profile outlines (faces + 1 per closed profile). The result replaces the solid and reports data: volumeDelta ' +
    '(exact, document units cubed), expectedVolumeDelta (closed form: plane A d; cylinder A d (1 +- d / 2r); cone A d +- (d^2 / 2) cos(alpha) A_uv), regionArea, regions, ' +
    'angularSpanRad, distortion, unverified (font not pinned) and provenance. A sketch wider than one turn refuses with WRP_WRAP_OVERLAP, a region leaving the face with ' +
    'WRP_OUTSIDE_FACE, a deboss as deep as the radius with WRP_DEPTH_EXCEEDS_SOLID, an open profile with WRP_PROFILE_OPEN, a sphere or freeform face with ' +
    'WRP_FACE_NOT_DEVELOPABLE. Needs the exact (native) kernel. Next: check_wrap, mass_properties, render_view.',
  params: z.object({
    id: z.string().describe('Id of the solid to emboss.'),
    face: faceRefField,
    profileIds: z.array(z.string()).min(1).max(MAX_PROFILES).describe('Ids of the closed 2D profiles (or font texts) to emboss.'),
    mode: z
      .enum(['emboss', 'deboss', 'scribe'])
      .describe(
        'emboss: material added outside the face; deboss: material removed inside it; scribe: the face is split along the outlines, no material change.',
      ),
    depth: z.number().optional().describe('Height of the emboss or depth of the deboss, document units, > 0. Not used by scribe.'),
    placement: placementField.optional(),
    maxLengthStrain: z
      .number()
      .positive()
      .optional()
      .describe('Largest accepted relative length change of the wrap (1 = 100 %). Default 0.02 (named default); develop faces have none.'),
    fitTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest deviation of a fitted pcurve from its exact image, document units. Default: 1e-6 x the solid diagonal (named default).',
      ),
  }),
  annotations: { requiresKernel: true },
  run: (doc, params, ctx): CommandResult => {
    const session = openFace(doc, ctx, 'emboss_on_face', params.id, params.face);
    if (isRejection(session)) return session;
    const fail = (code: string, message: string, paths: string[], ids: readonly string[] = [params.id]): CommandResult =>
      wrapRejection(doc, 'emboss_on_face', code, message, [...ids], paths);
    const scribe = params.mode === 'scribe';
    if (!scribe && !(typeof params.depth === 'number' && Number.isFinite(params.depth) && params.depth > 0))
      return fail('WRP_DEPTH_INVALID', `depth must be a finite number > 0 for ${params.mode} (got ${String(params.depth)})`, ['depth']);
    const resolved = resolveChart(doc, session, params.placement, params.face.faceNear);
    if ('summary' in resolved) return resolved;
    const outlines: SketchOutline[] = [];
    for (const [index, profileId] of params.profileIds.entries()) {
      const outline = sketchOutline(doc, profileId);
      if (isSketchFailure(outline)) return fail(outline.code, outline.message, [`profileIds.${index}`], [profileId]);
      if (outline.open.length > 0 || outline.regions.length === 0)
        return fail(
          'WRP_PROFILE_OPEN',
          `profile '${profileId}' (${outline.kind}) is not a closed shape; ${scribe ? 'scribe of open curves is not built yet' : 'close it, or use mode scribe'}`,
          [`profileIds.${index}`],
          [profileId],
        );
      for (const region of outline.regions)
        for (const chain of [region.outer, ...region.holes])
          if (selfIntersects(polygonOf(chain)))
            return fail('WRP_PROFILE_SELF_INTERSECT', `profile '${profileId}' crosses itself`, [`profileIds.${index}`], [profileId]);
      outlines.push(outline);
    }
    const { chart } = resolved;
    const depth = scribe ? 0 : (params.depth as number);
    const tolerance = params.fitTolerance ?? defaultFitTolerance(session.diagonal);
    const regions = outlines.flatMap((outline) => outline.regions);
    const mapped = mapOutlineRegions(session, chart, regions, tolerance);
    if (isMappingFailure(mapped)) return fail(mapped.code, mapped.message, ['profileIds'], params.profileIds);
    const overlap = checkWrapAround(chart, mapped.pieces, params.profileIds);
    if (overlap !== null) {
      const result = fail(overlap.code, overlap.message, ['profileIds'], params.profileIds);
      return { ...result, data: { fullWrapChartWidth: chart.fullWrapWidth, unit: doc.units } };
    }
    const outside = checkOnFace(session, probePoints(chart, mapped.pieces, MAX_PROBES), params.profileIds);
    if (outside !== null) return fail(outside.code, outside.message, ['profileIds'], params.profileIds);
    const recipeParams: EmbossParams = {
      face: session.face,
      surface: chart.wire,
      regions: mapped.regions,
      mode: params.mode,
      depth,
      direction: scale3(chart.normalAt(mapped.regions[0]?.outer.start as Vec2), resolved.orientation),
      tolerance: Math.max(SEWING_RATIO * session.diagonal, MIN_FIT_TOLERANCE),
    };
    const recipe: ShapeRecipe = { op: 'emboss', source: session.source, ...recipeParams };
    const closed = embossClosedForm(recipeParams);
    const reach = debossLimit(session, mapped.pieces, closed?.convex ?? null);
    if (params.mode === 'deboss' && reach !== null && depth >= reach * (1 - 1e-9)) {
      const result = fail(
        'WRP_DEPTH_EXCEEDS_SOLID',
        `depth ${depth} reaches the ${reach.toPrecision(6)} ${doc.units} between the deepest point of the profile and the axis of the ${session.surface.type} face`,
        ['depth'],
      );
      return { ...result, data: { maxDepth: reach, unit: doc.units } };
    }
    const built = evaluateRecipe(session.kernel, recipe);
    if (typeof built === 'string')
      return fail(
        'WRP_KERNEL_BUILD_FAILED',
        `the exact kernel could not ${params.mode} ${mapped.regions.length} region(s) on face ${session.face} (${built}); try a smaller depth or profile`,
        ['profileIds'],
        params.profileIds,
      );
    const before = kernelVolume(session, session.shape);
    const after = kernelVolume(session, built.shape);
    const volumeDelta = before !== null && after !== null ? after - before : null;
    const areas = regionsAreas(mapped.regions);
    const unverified = outlines.some((outline) => outline.unverified);
    const fontOutline = outlines.find((outline) => outline.font !== null);
    const spanU =
      Math.max(...mapped.pieces.flat().flatMap((piece) => sampleSegment(piece, 9).map((p) => p[0]))) -
      Math.min(...mapped.pieces.flat().flatMap((piece) => sampleSegment(piece, 9).map((p) => p[0])));
    const limit = params.maxLengthStrain ?? DEFAULT_MAX_LENGTH_STRAIN;
    const data = wrapData(
      doc,
      {
        volumeDelta,
        expectedVolumeDelta: closed?.delta ?? null,
        regionArea: closed?.area ?? areas.uv,
        regions: mapped.regions.length,
        loops: mapped.pieces.length,
        mode: params.mode,
        depth,
        method: 'develop',
        exact: true,
        faceKind: session.surface.type,
        face: session.face,
        ...(session.faceName !== undefined ? { faceName: session.faceName } : {}),
        ...(chart.kind === 'plane'
          ? {}
          : {
              angularSpanRad: spanU,
              ...(chart.kind === 'cone'
                ? { developedSectorRad: spanU * Math.sin((session.surface as { semiAngle?: number }).semiAngle ?? 1) }
                : {}),
            }),
        distortion: { maxLengthStrain: 0, meanLengthStrain: 0, areaRatio: 1, limit, method: 'develop' },
        fullWrapChartWidth: chart.fullWrapWidth,
        convex: closed?.convex ?? null,
      },
      {
        unverified,
        provenance: {
          method: `${params.mode} of wrapped regions: one face-slab per region, fused / cut / split in a single exact operation`,
          ...(fontOutline?.font != null ? { font: fontOutline.font } : {}),
          inputs: {
            id: params.id,
            face: session.face,
            profileIds: params.profileIds,
            mode: params.mode,
            depth,
            placement: params.placement ?? { method: 'develop' },
          },
        },
        defaults: [
          ...(params.fitTolerance === undefined
            ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull WRP default (D-WRP-4): 1e-6 x the solid diagonal')]
            : []),
          ...(params.maxLengthStrain === undefined
            ? [{ ...namedDefault('maxLengthStrain', DEFAULT_MAX_LENGTH_STRAIN, '1', MAX_LENGTH_STRAIN_SOURCE) }]
            : []),
        ],
      },
    );
    const committed = commitKernelResult(doc, session.kernel, built, [session.entity], (newId, triangles) => {
      const change =
        volumeDelta === null
          ? 'volume change not measured'
          : `volume ${volumeDelta >= 0 ? '+' : ''}${volumeDelta.toPrecision(9)} ${doc.units}^3`;
      return `emboss_on_face: ${params.mode} of ${params.profileIds.length} profile(s) (${mapped.regions.length} region(s), area ${(closed?.area ?? areas.uv).toPrecision(8)} ${doc.units}^2${scribe ? '' : `, depth ${depth}`}) on ${session.surface.type} face ${session.face} of '${params.id}' → mesh '${newId}' (${triangles} triangles), ${change}${unverified ? '; unverified font' : ''}. Source solid consumed, profiles kept.${session.note}`;
    });
    return { ...committed, data, ...(session.faceName !== undefined ? { recordExtras: { face: { faceName: session.faceName } } } : {}) };
  },
});
