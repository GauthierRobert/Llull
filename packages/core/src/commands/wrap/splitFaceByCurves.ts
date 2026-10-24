/** split_face_by_curves — divide the faces of a solid along curves lying on them (03 WRP M4): a split line, a paint mask, a parting line. */

import type { NurbsCurve2Data } from '../../lib/nurbs/curve2d';
import type { ShapeRecipe, Vec2, Vec3 } from '../../model/types';
import type { UvLoop } from '../../model/wrap';
import { closestOnCurve } from '../../lib/nurbs/closest';
import { curveDomain, evaluateCurve } from '../../lib/nurbs/evaluate';
import { interpolatePoints } from '../../lib/nurbs/interpolate';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { distance3 } from '../../lib/vec3';
import { defineCommand, z } from '../schema';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { namedDefault, wrapData } from './conventions';
import { isRejection, openSolid, type SolidSession } from './faceSession';
import { continuousUv, curveSamples, snapChainEnds } from './splitChains';

const MAX_CURVES = 500;

interface Failure {
  readonly code: string;
  readonly message: string;
}

const isFailure = (value: UvLoop | Failure): value is Failure => 'code' in value;

/** Sample counts tried for the curve in the face parameters: few knots integrate well in the kernel, more are used only when the check demands them. */
const SAMPLE_COUNTS = [24, 48, 96, 192, 384];

/** Relative volume change a split may show: the kernel's fixed-rule mass integration of faces trimmed by fitted spline edges resolves volumes to about 1e-6 (measured 8e-7 on a cylinder with a circle patch). */
const VOLUME_RESOLUTION = 1e-5;
/** Relative change of the summed face area a split may show (the faces are trimmed by fitted edges; measured 1e-8 and below). */
const AREA_RESOLUTION = 1e-5;

/** One attempt: `count` samples of the curve projected into the face parameters and interpolated with end directions (fourth order), then checked against the curve. */
function attemptChain(session: SolidSession, face: number, curve: NurbsCurveData, tolerance: number, count: number): UvLoop | Failure {
  const surface = session.query.faceGeometry(session.shape, face)?.surface;
  if (surface === undefined) return { code: 'WRP_KERNEL_BUILD_FAILED', message: `face ${face} has no exact geometry` };
  const points = curveSamples(curve, count + 1);
  const projected = session.query.projectOnFace(session.shape, face, points);
  if (projected === null || projected.some((hit) => hit === null || hit.distance > tolerance))
    return { code: 'WRP_SPLIT_CURVE_NOT_ON_FACE', message: `the curve leaves face ${face} by more than ${tolerance}` };
  const periodic: readonly [boolean, boolean] = [surface.type !== 'plane' && surface.type !== 'other', surface.type === 'torus'];
  const uvs = continuousUv(
    projected.map((hit) => (hit === null ? ([0, 0] as Vec2) : hit.uv)),
    periodic,
  );
  // a loop closed in the face parameters ends exactly where it starts; one that winds round a periodic face stays open in (u, v)
  const [start, end] = [uvs[0] as Vec2, uvs[count] as Vec2];
  const loopClosed =
    distance3(points[0] as Vec3, points[count] as Vec3) < tolerance && Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-4;
  if (loopClosed) uvs[count] = start;
  const at = (k: number): Vec2 => uvs[k] as Vec2;
  const oneSided = (k: number, sign: 1 | -1): Vec3 => [
    sign * (-3 * at(k)[0] + 4 * at(k + sign)[0] - at(k + 2 * sign)[0]),
    sign * (-3 * at(k)[1] + 4 * at(k + sign)[1] - at(k + 2 * sign)[1]),
    0,
  ];
  const startTangent: Vec3 = loopClosed ? [at(1)[0] - at(count - 1)[0], at(1)[1] - at(count - 1)[1], 0] : oneSided(0, 1);
  const endTangent: Vec3 = loopClosed ? startTangent : oneSided(count, -1);
  const fitted = interpolatePoints(
    uvs.map(([u, v]): Vec3 => [u, v, 0]),
    { degree: 3, parameterization: 'chord', startTangent, endTangent },
  );
  if ('code' in fitted)
    return { code: 'WRP_SPLIT_FIT_FAILED', message: `the curve has coincident samples on the face (${fitted.message})` };
  const pcurve: NurbsCurve2Data = { ...fitted.curve, poles: fitted.curve.poles.map(([u, v]): Vec2 => [u, v]) };
  const [first, last] = curveDomain(fitted.curve);
  const middles = Array.from({ length: 2 * count }, (_, k): Vec2 => {
    const image = evaluateCurve(fitted.curve, first + ((last - first) * (k + 0.5)) / (2 * count));
    return [image[0], image[1]];
  });
  const image = session.query.evaluateFace(session.shape, face, middles);
  if (image === null) return { code: 'WRP_SPLIT_FIT_FAILED', message: 'the kernel could not evaluate the face along the fitted curve' };
  const deviation = Math.max(...image.map((e) => closestOnCurve(curve, e.point).distance));
  if (deviation > 0.1 * tolerance)
    return {
      code: 'WRP_SPLIT_FIT_FAILED',
      message: `the curve in the face parameters deviates ${deviation} from the curve (limit ${0.1 * tolerance}); split it in smaller pieces`,
    };
  return { start: uvs[0] as Vec2, segments: [{ kind: 'nurbs', curve: pcurve }] };
}

/** The curve as a pcurve chain in the face's own (u, v), with the fewest samples that pass the check. */
function chainOf(session: SolidSession, face: number, curve: NurbsCurveData, tolerance: number): UvLoop | Failure {
  let last: Failure = { code: 'WRP_SPLIT_FIT_FAILED', message: 'no sample count tried' };
  for (const count of SAMPLE_COUNTS) {
    const attempt = attemptChain(session, face, curve, tolerance, count);
    if (!isFailure(attempt) || attempt.code !== 'WRP_SPLIT_FIT_FAILED') return attempt;
    last = attempt;
  }
  return last;
}

/**
 * @affects replaces the solid by a kernel result (a new mesh entity carrying the exact recipe); the curves stay; the divided faces get new persistent names
 * @invariant the volume is unchanged (a split moves no material); the curves are re-expressed in each face's own (u, v) by projecting their samples and checked back against them within
 *   tolerance, so a curve that does not lie on the face is refused, never forced onto it
 * @failure unknown ids / not a solid / no exact kernel / a curve that is no nurbs_curve or lies on no face of the solid / a fit outside the tolerance / nothing divided -> coded no-op
 */
export const splitFaceByCurves = defineCommand({
  name: 'split_face_by_curves',
  description:
    'Divide the faces of a solid along curves lying on them (nurbs_curves made by wrap_to_face, project_to_face or create_curve_on_face on this solid): a closed curve cuts out a patch ' +
    '(faces + 1), an open one that runs from edge to edge divides the face in two. The volume does not change; the divided faces get new persistent names, so later commands ' +
    '(colour, draft, PMI, emboss_on_face) can address the patches. Each curve must lie on one face of the solid within `tolerance` (default 1e-5 x the solid diagonal, a named default): ' +
    'its samples are projected into the face parameters, fitted and checked back against the curve. Returns data { facesBefore, facesAfter, faces[{ index, name, area }] (the new faces; area ' +
    'in document units squared), volumeBefore, volumeAfter }. Refuses with WRP_SPLIT_CURVE_NOT_ON_FACE (the curve is no curve-on-face of this solid), WRP_SPLIT_FIT_FAILED, ' +
    'WRP_SPLIT_NO_EFFECT (the curves divide nothing, e.g. an open curve ending inside the face). Needs the exact (native) kernel. Next: inspect_faces, emboss_on_face, mass_properties.',
  params: z.object({
    id: z.string().describe('Id of the solid to divide.'),
    curveIds: z
      .array(z.string())
      .min(1)
      .max(MAX_CURVES)
      .describe('Ids of the nurbs_curve entities (with onFace) to divide along; each must lie on a face of this solid.'),
    tolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest distance a curve may lie from its face, and the fit tolerance of its face-parameter curve, document units. Default: 1e-5 x the solid diagonal (named default).',
      ),
  }),
  annotations: { requiresKernel: true },
  run: (doc, params, ctx): CommandResult => {
    const session = openSolid(doc, ctx, 'split_face_by_curves', params.id);
    if (isRejection(session)) return session;
    const fail = (code: string, message: string, ids: readonly string[] = [], paths: string[] = ['curveIds']): CommandResult =>
      wrapRejection(doc, 'split_face_by_curves', code, message, [...ids], paths);
    const curves: Array<{ id: string; curve: NurbsCurveData; fit: number }> = [];
    for (const [index, id] of params.curveIds.entries()) {
      const entity = doc.entities[id];
      if (entity === undefined) return fail('WRP_ENTITY_NOT_FOUND', `entity '${id}' not found`, [id], [`curveIds.${index}`]);
      if (entity.kind !== 'nurbs_curve' || entity.onFace === undefined)
        return fail(
          'WRP_SPLIT_CURVE_NOT_ON_FACE',
          `'${id}' (${entity.kind}) is not a curve lying on a face (make it with wrap_to_face, project_to_face or create_curve_on_face)`,
          [id],
          [`curveIds.${index}`],
        );
      curves.push({ id, curve: entity.curve, fit: entity.onFace.fitTolerance });
    }
    const tolerance = params.tolerance ?? 1e-5 * session.diagonal;
    const facesBefore = session.topology?.faces ?? [];
    const faceKey = (face: { name?: string; area: number }): string => `${face.name ?? ''}|${face.area.toPrecision(9)}`;
    const keysBefore = new Set(facesBefore.map(faceKey));
    // the face of each curve in the initial solid: all its samples have the same nearest face, within tolerance
    const groups = new Map<number, Array<{ id: string; curve: NurbsCurveData; anchor: Vec3 }>>();
    for (const item of curves) {
      const samples = curveSamples(item.curve, 17);
      // an open curve ends on the boundary of its face, where the nearest face may be the neighbour: only its interior samples name the face
      const open = distance3(samples[0] as Vec3, samples[samples.length - 1] as Vec3) > tolerance;
      const hits = session.query.distance(session.shape, open ? samples.slice(1, -1) : samples);
      if (hits === null) return fail('WRP_KERNEL_BUILD_FAILED', 'the kernel could not measure the curve against the faces', [item.id]);
      const faces = new Set(hits.map((hit) => hit.face));
      const farthest = Math.max(...hits.map((hit) => hit.distance));
      const face = hits[0]?.face ?? -1;
      if (faces.size !== 1 || face < 0 || farthest > Math.max(tolerance, 10 * item.fit))
        return fail(
          'WRP_SPLIT_CURVE_NOT_ON_FACE',
          `'${item.id}' does not lie on one face of '${params.id}' (nearest faces ${[...faces].join(', ')}, farthest ${farthest.toPrecision(4)} ${doc.units} from them)`,
          [item.id, params.id],
        );
      groups.set(face, [
        ...(groups.get(face) ?? []),
        {
          id: item.id,
          curve: item.curve,
          anchor: evaluateCurve(item.curve, (curveDomain(item.curve)[0] + curveDomain(item.curve)[1]) / 2),
        },
      ]);
    }
    // split face after face, finding each face again in the updated solid
    let recipe: ShapeRecipe = session.source;
    let current: SolidSession = session;
    for (const group of groups.values()) {
      const face = current.query.distance(current.shape, [(group[0] as (typeof group)[number]).anchor])?.[0]?.face ?? -1;
      if (face < 0)
        return fail(
          'WRP_SPLIT_CURVE_NOT_ON_FACE',
          'a curve lies on an edge, not inside a face',
          group.map((item) => item.id),
        );
      const chains: UvLoop[] = [];
      for (const item of group) {
        const chain = chainOf(current, face, item.curve, tolerance);
        if (isFailure(chain)) return fail(chain.code, `'${item.id}': ${chain.message}`, [item.id, params.id]);
        chains.push(chain);
      }
      recipe = {
        op: 'emboss',
        source: recipe,
        face,
        surface: { type: 'face', data: [] },
        regions: [],
        chains: snapChainEnds(chains, 1e-4),
        mode: 'split',
        depth: 0,
        direction: [0, 0, 1],
        tolerance: Math.max(1e-6 * session.diagonal, 1e-7),
      };
      const built = session.kernel.evaluate(recipe);
      if (built === null)
        return fail(
          'WRP_KERNEL_BUILD_FAILED',
          `the exact kernel could not split face ${face} along ${group.length} curve(s)`,
          group.map((item) => item.id),
        );
      current = { ...current, shape: built, topology: session.kernel.topology(built) };
    }
    const result = evaluateRecipe(session.kernel, recipe);
    if (typeof result === 'string')
      return fail('WRP_KERNEL_BUILD_FAILED', `the exact kernel could not split '${params.id}' (${result})`, [params.id]);
    const facesAfter = session.kernel.topology(result.shape)?.faces ?? [];
    if (facesAfter.length <= facesBefore.length)
      return fail(
        'WRP_SPLIT_NO_EFFECT',
        `the ${params.curveIds.length} curve(s) divide no face of '${params.id}' (${facesBefore.length} faces before and after)`,
        [...params.curveIds, params.id],
      );
    const health = session.kernel.analyze?.(result.shape) ?? null;
    if (health !== null && !(health.valid && health.closed))
      return fail('WRP_KERNEL_BUILD_FAILED', `the split is not a valid closed solid (${health.status}); refused`, [params.id]);
    const massBefore = session.kernel.massProperties?.(session.shape) ?? null;
    const massAfter = session.kernel.massProperties?.(result.shape) ?? null;
    const volumeBefore = massBefore?.volume ?? null;
    const volumeAfter = massAfter?.volume ?? null;
    // a split moves no material: the volumes agree within what the kernel's own integration can resolve
    const resolution = VOLUME_RESOLUTION + 3 * ((massBefore?.relError ?? 0) + (massAfter?.relError ?? 0));
    if (
      volumeBefore !== null &&
      volumeAfter !== null &&
      Math.abs(volumeAfter - volumeBefore) > resolution * Math.max(Math.abs(volumeBefore), 1e-12)
    )
      return fail(
        'WRP_KERNEL_BUILD_FAILED',
        `the split changed the volume (${volumeBefore} -> ${volumeAfter}, resolution ${resolution}); refused`,
        [params.id],
      );
    const areaBefore = facesBefore.reduce((sum, face) => sum + face.area, 0);
    const areaAfter = facesAfter.reduce((sum, face) => sum + face.area, 0);
    // a split moves no material and no surface: the total face area is the same
    if (Math.abs(areaAfter - areaBefore) > AREA_RESOLUTION * Math.max(areaBefore, 1e-12))
      return fail(
        'WRP_KERNEL_BUILD_FAILED',
        `the split changed the total face area (${areaBefore} -> ${areaAfter}, resolution ${AREA_RESOLUTION} relative); refused`,
        [params.id],
      );
    const created = facesAfter
      .filter((face) => !keysBefore.has(faceKey(face)))
      .map((face) => ({ index: face.index, name: face.name ?? '', area: face.area }));
    const data = wrapData(
      doc,
      {
        facesBefore: facesBefore.length,
        facesAfter: facesAfter.length,
        faces: created,
        volumeBefore,
        volumeAfter,
        volumeRelativeChange: volumeBefore === null || volumeAfter === null ? null : (volumeAfter - volumeBefore) / volumeBefore,
        volumeResolution: resolution,
        areaSumBefore: areaBefore,
        areaSumAfter: areaAfter,
      },
      {
        unverified: false,
        provenance: {
          method: 'curves re-expressed in the face parameters and split with the exact kernel splitter',
          inputs: { id: params.id, curveIds: params.curveIds },
        },
        defaults:
          params.tolerance === undefined
            ? [namedDefault('tolerance', tolerance, doc.units, 'llull WRP default (D-WRP-4): 1e-5 x the solid diagonal')]
            : [],
      },
    );
    const committed = commitKernelResult(
      doc,
      session.kernel,
      result,
      [session.entity],
      (newId, triangles) =>
        `split_face_by_curves: ${params.curveIds.length} curve(s) divide '${params.id}' (${facesBefore.length} → ${facesAfter.length} faces, ${created.length} new) → mesh '${newId}' (${triangles} triangles); volume unchanged. Source solid consumed, curves kept.`,
    );
    return { ...committed, data };
  },
});
