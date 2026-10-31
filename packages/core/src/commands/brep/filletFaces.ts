/**
 * fillet_faces (BLD M4, TECHNICAL_SPEC §4, §5.6): a rolling-ball blend between two face sets. One planar face per set with a constant radius
 * need not share an edge (a chamfer face between them is consumed); sets of several planar or curved faces that meet, a varying radius
 * (radiusEnd / law), a chord width and a hold line blend the edges the sets share, through fillet_edge's builder.
 */

import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { holdLineLaw } from '../../geometry/blend/holdLine';
import { diagonalOf } from './shapeDiagonal';
import { filletEach } from './filletEach';
import { type BlendBuild, type BlendContext, type FaceSetInput, faceSetSchema, pickedFaces, runFaceBlend } from './faceBlendRun';
import { type ProfileInput, isProfileRefusal, profileSchema, resolveProfile } from './filletProfile';
import { cliffOutcome } from './cliffOutcome';
import { blendRejection } from './blendCodes';
import { edgeLawSchema } from './filletSpec';
import { edgeBlend, onePlanarFaceEach, readEdgeResult } from './faceBlendEdges';

const HOLD_STATIONS = 33;
const unsupported = (message: string, path: string): BlendBuild => ({ code: 'BLD_FACE_BLEND_UNSUPPORTED', message, path });

/** World points of a drawn 2D line or polyline, or null for any other entity. */
function holdPolyline(entity: Entity | undefined): Vec3[] | null {
  if (entity?.kind === 'line') return [entity.start, entity.end].map(([x, y]) => entityLocalToWorld(entity, [x, y, 0]));
  if (entity?.kind === 'polyline') return entity.points.map(([x, y]) => entityLocalToWorld(entity, [x, y, 0]));
  return null;
}

interface HoldRequest {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext | undefined;
  readonly id: string;
  readonly holdId: string;
  readonly onFaces: 'A' | 'B';
  readonly profile: ProfileInput | undefined;
  readonly facesA: FaceSetInput;
  readonly facesB: FaceSetInput;
}

/** The blend of the shared edge of faces A and B whose contact line on `onFaces` follows the hold line, as the result of fillet_edge's law builder. */
function holdLineBlend(request: HoldRequest, context: BlendContext): BlendBuild {
  const { kernel, shape, topology } = context;
  const [a, b] = [pickedFaces(context, 'facesA'), pickedFaces(context, 'facesB')];
  const [faceA, faceB] = [a[0], b[0]];
  if (a.length !== 1 || b.length !== 1 || faceA === undefined || faceB === undefined)
    return unsupported('a hold line blends one face against one face', 'facesA');
  const graph = kernel.faceQuery?.faceGraph(shape) ?? null;
  const edge = graph?.edgeFaces.findIndex((around) => around.includes(faceA) && around.includes(faceB)) ?? -1;
  if (graph === null || edge < 0)
    return unsupported('a hold line drives the blend of the edge the two faces share: these faces share none', 'holdLine');
  const normals = [topology?.faces[faceA]?.normal, topology?.faces[faceB]?.normal];
  const [normalA, normalB] = normals;
  if (normalA === undefined || normalB === undefined) return unsupported('a hold line needs two planar faces', 'holdLine');
  const polyline = holdPolyline(request.doc.entities[request.holdId]);
  if (polyline === null)
    return { code: 'BLD_HOLD_LINE_NOT_ON_FACE', message: `'${request.holdId}' is not a drawn line or polyline`, path: 'holdLine.id' };
  const samples = kernel.faceQuery?.edgeSamples(shape, edge, HOLD_STATIONS) ?? null;
  if (samples === null) return unsupported('the kernel cannot sample the shared edge', 'holdLine');
  const stations = samples.map((sample) => ({ t: sample.t, point: sample.point, tangent: sample.tangent }));
  const onA = request.onFaces === 'A';
  // the fold is the kernel's measured angle between the outward normals (the plane normals of the topology are only good up to their sign)
  const measured = kernel.faceQuery?.edgeContinuity(shape, edge, 3) ?? null;
  const fold = measured?.[1]?.g1;
  if (fold === undefined) return unsupported('the kernel cannot measure the angle between the two faces', 'holdLine');
  const found = holdLineLaw(stations, polyline, onA ? normalA : normalB, fold, diagonalOf(kernel, shape));
  if ('problem' in found)
    return found.offFace
      ? { code: 'BLD_HOLD_LINE_NOT_ON_FACE', message: found.problem, path: 'holdLine' }
      : unsupported(found.problem, 'holdLine');
  const { size, sizeEnd = size, sizes = [] } = found.law;
  const constant = sizes.length === 0 && Math.abs(sizeEnd - size) <= 1e-9 * size;
  const result = filletEach(request.doc, request.ctx, {
    id: request.id,
    mode: 'radius',
    edges: [
      constant
        ? { index: edge, size }
        : { index: edge, size, sizeEnd, sizes: sizes.map((point) => ({ t: point.t, size: point.size })), interpolation: 'linear' },
    ],
    edgeIndices: [],
    edgesNear: [],
    radius: undefined,
    radiusEnd: undefined,
    profile: request.profile,
  });
  return readEdgeResult(result, {
    doc: request.doc,
    context,
    seeds: [edge],
    varying: !constant,
    varyingPath: 'holdLine',
    rename: (path) => (path.startsWith('edges[') ? 'holdLine' : path),
    flipped: false,
  });
}

/**
 * @affects removes the source solid; creates 1 mesh entity with the blend faces (and the consumed faces gone); data { id, blends, consumedFaces, unit } (with cliff also cliffEngaged, and when engaged cliffEdgeAngle in degrees and cliffFace) and, on the edge path, blendEdges [{ index, start, end }]
 * @invariant requiresKernel; exactly one of radius / width / law / holdLine; radiusEnd only with radius, widthEnd only with width; each set resolves to faces and the sets share none; the blend is tangent to both sets
 * @failure BLD_FACESET_EMPTY, BLD_FACESETS_OVERLAP, BLD_FACE_FILLET_NO_SOLUTION (with the smallest radius), BLD_FACE_BLEND_UNSUPPORTED (no shared sharp edge for curved / multi-face sets or a varying size; a kernel tangent chain that rests on a face outside both sets; a varying size over several chains, a branch or a bend at a joint; startNear on a closed edge; a cliff face that is not a band between two straight edges parallel to the blend, a cliff edge higher off the other face than the radius, a cliff on curved or multi-face sets), BLD_BLEND_PARAMS (cliff with a varying size, a width, a hold line or a non-circular profile), BLD_HOLD_LINE_NOT_ON_FACE, BLD_LAW_INVALID, BLD_LAW_NOT_PERIODIC, BLD_CHORD_UNDEFINED, BLD_RHO_RANGE, BLD_SHAPE_RANGE, REF_LOST / REF_SPLIT -> unchanged document
 */
export const filletFaces = defineCommand({
  name: 'fillet_faces',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  description:
    'Blend two sets of faces of a 3D solid that meet along edges, or, as one planar face per set with a constant radius and no shared edge, do not (a rolling ball of radius `radius` touching both, tangent to each) and replace the solid by the result; the faces between the contact lines (e.g. a chamfer between two walls) are consumed ' +
    '(data.consumedFaces lists them, data.blends the new blend face). facesA / facesB pick faces by points on them (near) and/or persistent names. ' +
    'Alternatively holdLine { id of a drawn line or polyline lying on one of the two faces, onFaces "A" | "B" } rounds the edge the two faces share with the radius that makes the blend leave that face on the drawn curve (radius = distance to the edge / tan(fold / 2), fold = angle between the outward normals); a conic / curvature profile with a hold line follows the profile rules of fillet_edge (a sloped line is a varying size, which a profile blend takes). ' +
    'profile { type: "conic", rho } or { type: "curvature", shape } changes the section. Each set may hold several faces, planar or curved (cylinders, cones, spheres, B-spline faces, tangent-continuous or not): the blend runs along every sharp edge shared by a face of facesA and a face of facesB, built as fillet_edge builds it (same radius laws, chord mode, profiles and limits; data.blendEdges lists them with their two ends). The blend rounds the whole tangent chain of every shared edge, as fillet_edge does: if that chain bounds a face outside facesA and facesB the blend is refused (BLD_FACE_BLEND_UNSUPPORTED names the edges and faces) rather than round a face you did not pick. ' +
    'radiusEnd (smooth start-to-end radius), law { expression, samples } (radius as an expression of t in [0, 1] along the shared edge) and width (the CHORD between the two contact lines at the start, widthEnd at the end) vary or size the blend like fillet_edge; a varying size runs over the whole blend: one edge, or a tangent chain of several shared edges (one open path or one closed loop whose joints are tangent: a line, an arc and a line of a rounded outline), where radiusEnd / widthEnd change in a straight line in arc length from the start of the chain to its end and law is an expression of t over the total arc length of the chain (the kernel gets one sub-law per edge, equal at every joint); several separate chains, a branch or a bend at a joint are refused by name. startNear picks which end of the edge or chain is t = 0. ' +
    'Faces that share no sharp edge (a chamfer, a groove or a gap between them is consumed) are blended by the closed form of the rolling ball (data.blends names the blend face): (1) PLANAR sets: each set is one plane (one or several coplanar faces; the contact line may cross from one face of a set to the next) and the blend runs over the length the two sets overlap, ending on flat faces square to it; radius constant, or radius with radiusEnd for a straight taper (a cone; radiusEnd is linear, not the smooth S-curve of the edge route; startNear picks the end where radius applies); (2) ROUND sets: a plane square to an axis, a cylinder or a cone about that axis, in any pair (a boss on a plate across a chamfer, a bore against a floor, two cones), the blend is swept once around the axis with a constant radius. The contact lines and the arc are checked exactly against the faces (a groove, a hole or a missing sector in a set is refused, not spanned). check_blends does NOT verify the radius of such a blend (a face-set blend has no radius-law record to read back, so a wrong taper from radius to radiusEnd passes it; it checks validity and G1 continuity only): measure the section (measure, section_solid) when the taper matters. Refused by name with the measured reason: spheres, tori, B-spline faces, a plane that is not square to the axis, axes that differ, a set whose faces are not on one support surface, parallel faces, a law or width, a profile other than circular with radiusEnd, a taper about an axis. ' +
    'cliff "A" | "B" (one planar face per set, constant radius, circular section): when the ball would run off the far edge of that face (the face is narrower than the tangent contact distance radius * tan(fold / 2)), the blend stops at that edge, the cliff edge: the ball stays tangent to the other face and touches the cliff edge instead of being tangent to its face, so the blend is G1 to the other face and meets the cliff edge at an angle; the cliff face is consumed. Without a run-off the ordinary tangent blend is built. data.cliffEngaged says which, data.cliffEdgeAngle (degrees, 0 = tangent) is the angle at the cliff edge and data.cliffFace the consumed face. Other trim modes (extending or trimming the blend past its ends) are not offered. Without cliff, a blend that runs off a face is refused (BLD_FACE_FILLET_NO_SOLUTION / BLD_FACE_BLEND_UNSUPPORTED). BLD_FACE_FILLET_NO_SOLUTION says when no ball of that radius stays in the material (and the smallest radius that does), ' +
    'BLD_FACE_BLEND_UNSUPPORTED what else is not built. Needs the exact native kernel (check kernel_info); with the mesh kernel it no-ops. Run check_blends afterwards.',
  params: z.object({
    id: z.string().describe('Id of the 3D solid entity to blend. Must exist and be a 3D solid kind.'),
    facesA: faceSetSchema.describe('First face set: one or several faces, planar or curved.'),
    facesB: faceSetSchema.describe('Second face set: one or several faces; must not share a face with facesA.'),
    radius: z
      .number()
      .describe('Radius of the rolling ball in document units (> 0). Give exactly one of radius, width, law or holdLine.')
      .optional(),
    radiusEnd: z
      .number()
      .describe(
        'With radius: radius at the END of the shared edge (> 0, document units); the radius goes smoothly from radius to radiusEnd as fillet_edge radiusEnd does. Over a chain of several shared edges the radius changes in a straight line in arc length (one edge: as fillet_edge radiusEnd); equal to radius on a closed edge or a closed loop.',
      )
      .optional(),
    width: z
      .number()
      .describe(
        'Chord between the two contact lines at the START of the shared edge (> 0, document units) instead of a radius (fillet_edge mode "chord"). Give exactly one of radius, width, law or holdLine.',
      )
      .optional(),
    widthEnd: z
      .number()
      .describe(
        'With width: chord at the END of the shared edge or chain (> 0, document units); over a chain it changes in a straight line in arc length.',
      )
      .optional(),
    law: edgeLawSchema.shape.law
      .unwrap()
      .describe(
        'Radius as an expression of t in [0, 1] along the shared edge (document units), e.g. "1 + 0.5*cos(2*pi*t)"; only t, pi, tau and built-in functions; > 0 at every sample; periodic on a closed edge or a closed loop. Over a chain of several shared edges t runs along its total arc length. samples: number of uniform samples (default and range as fillet_edge; over a chain, stations per edge joined by straight pieces). Give exactly one of radius, width, law or holdLine.',
      )
      .optional(),
    holdLine: z
      .object({
        id: z
          .string()
          .describe('Id of a drawn line or polyline (draw_polyline) lying on the face; its points are in the plane of that face.'),
        onFaces: z.enum(['A', 'B']).describe('Which set the curve lies on: "A" (facesA) or "B" (facesB).'),
      })
      .describe('Hold line: the blend leaves face set `onFaces` on this drawn curve. facesA and facesB must share an edge.')
      .optional(),
    startNear: vec3(
      'A point [x, y, z] in document units near the end of the blend edge where radius / width / the law at t = 0 applies. Without it the size starts at the edge own start (data.blendEdges and the summary give both ends). Only a varying size (radiusEnd, widthEnd, law) uses it; the blend must be one open edge or one open chain (a closed edge, a rim, or a closed loop has no start end: refused).',
    ).optional(),
    profile: profileSchema.optional(),
    cliff: z
      .enum(['A', 'B'])
      .describe(
        'Cliff edge: the face set ("A" = facesA, "B" = facesB) whose far straight edge stops the blend when the ball would run off that face. Needs one planar face per set that is a band between two straight edges parallel to the blend, a constant radius and the circular section. The ball then stays tangent to the other face and touches the cliff edge. If the ordinary tangent blend fits on the face, it is built and cliff changes nothing.',
      )
      .optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, facesA, facesB, radius, radiusEnd, width, widthEnd, law, holdLine } = params;
    const given = [radius, width, law, holdLine].filter((value) => value !== undefined).length;
    if (given !== 1)
      return blendRejection(
        doc,
        'fillet_faces',
        'BLD_BLEND_PARAMS',
        'give exactly one of radius, width, law or holdLine',
        [id],
        ['radius'],
      );
    if ((radiusEnd !== undefined && radius === undefined) || (widthEnd !== undefined && width === undefined)) {
      const name = radiusEnd !== undefined && radius === undefined ? 'radiusEnd' : 'widthEnd';
      return blendRejection(
        doc,
        'fillet_faces',
        'BLD_BLEND_PARAMS',
        `${name} needs ${name === 'radiusEnd' ? 'radius' : 'width'}`,
        [id],
        [name],
      );
    }
    const positive = { radius, radiusEnd, width, widthEnd };
    for (const [name, value] of Object.entries(positive))
      if (value !== undefined && !(value > 0))
        return blendRejection(doc, 'fillet_faces', 'BLD_LAW_INVALID', `${name} must be > 0 (got ${value})`, [id], [name]);
    const { cliff } = params;
    if (params.cliff !== undefined) {
      const clash = [
        ['radiusEnd', radiusEnd],
        ['width', width],
        ['law', law],
        ['holdLine', holdLine],
      ].find(([, value]) => value !== undefined);
      if (clash !== undefined)
        return blendRejection(
          doc,
          'fillet_faces',
          'BLD_BLEND_PARAMS',
          `cliff needs a constant radius (not ${String(clash[0])})`,
          [id],
          ['cliff'],
        );
    }
    const profile = resolveProfile(params.profile);
    if (isProfileRefusal(profile)) return blendRejection(doc, 'fillet_faces', profile.code, profile.message, [id], [profile.path]);
    const sets = { facesA, facesB };
    if (params.cliff !== undefined && profile.profile !== undefined && profile.profile.type !== 'circular')
      return blendRejection(doc, 'fillet_faces', 'BLD_BLEND_PARAMS', 'cliff takes the circular section only', [id], ['profile']);
    return runFaceBlend(doc, ctx, {
      command: 'fillet_faces',
      id,
      sets,
      describe: (newId, triangles, note) =>
        `fillet_faces: blended '${id}' (radius ${radius}${params.cliff === undefined ? '' : `, cliff edge on faces${params.cliff}`}) → mesh '${newId}' (${triangles} triangles). Source entity consumed.${note}`,
      ...(cliff === undefined ? {} : { outcome: (kernel, shape, after, before) => cliffOutcome(kernel, shape, after, before, cliff) }),
      build: (context) => {
        if (holdLine !== undefined)
          return holdLineBlend(
            { doc, ctx, id, holdId: holdLine.id, onFaces: holdLine.onFaces, profile: params.profile, facesA, facesB },
            context,
          );
        const spandrel = (): BlendBuild => ({
          recipe: {
            op: 'faceBlend',
            source: context.source,
            facesA: pickedFaces(context, 'facesA'),
            facesB: pickedFaces(context, 'facesB'),
            radius: radius ?? 0,
            ...(profile.profile === undefined ? {} : { profile: profile.profile }),
            ...(params.cliff === undefined ? {} : { cliff: params.cliff }),
            ...(radiusEnd === undefined ? {} : { radiusEnd, ...(params.startNear === undefined ? {} : { startNear: params.startNear }) }),
          },
        });
        if (params.cliff !== undefined)
          return onePlanarFaceEach(context) ? spandrel() : unsupported('a cliff edge needs one planar face in each set', 'cliff');
        return edgeBlend(
          {
            doc,
            ctx,
            id,
            profile: params.profile,
            size: { start: radius ?? width ?? 0, end: radiusEnd ?? widthEnd, law, chord: width !== undefined },
            startNear: params.startNear,
            spandrel: law !== undefined || width !== undefined ? undefined : spandrel,
          },
          context,
        );
      },
    });
  },
});
