/**
 * fillet_faces (BLD M4, TECHNICAL_SPEC §4, §5.6): a rolling-ball blend between two face sets that need not share an edge (a chamfer face
 * between them is consumed), or, with a hold line, a variable-radius blend of the edge the two faces share whose contact line on one face is
 * a drawn curve. Built by the exact kernel for one planar face per set.
 */

import type { CadDocument, Entity, Vec3 } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, z } from '../schema';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { holdLineLaw } from '../../geometry/blend/holdLine';
import { diagonalOf } from './shapeDiagonal';
import { filletEach } from './filletEach';
import { type BlendBuild, type BlendContext, type FaceSetInput, faceSetSchema, pickedFaces, runFaceBlend } from './faceBlendRun';
import { type ProfileInput, isProfileRefusal, profileSchema, resolveProfile } from './filletProfile';
import { blendRejection } from './blendCodes';

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
  return { result: { ...result, summary: result.summary.replace(/^fillet_edge/, 'fillet_faces') } };
}

/**
 * @affects removes the source solid; creates 1 mesh entity with the blend face (and the consumed faces gone); data { id, blends, consumedFaces, unit }
 * @invariant requiresKernel; exactly one of radius / holdLine; each set resolves to a face and the sets share none; the blend is tangent to both faces
 * @failure BLD_FACESET_EMPTY, BLD_FACESETS_OVERLAP, BLD_FACE_FILLET_NO_SOLUTION (with the smallest radius), BLD_FACE_BLEND_UNSUPPORTED, BLD_HOLD_LINE_NOT_ON_FACE, BLD_RHO_RANGE, BLD_SHAPE_RANGE, REF_LOST / REF_SPLIT -> unchanged document
 */
export const filletFaces = defineCommand({
  name: 'fillet_faces',
  annotations: { requiresKernel: true },
  description:
    'Blend two sets of faces of a 3D solid that need not share an edge (a rolling ball of radius `radius` touching both, tangent to each) and replace the solid by the result; the faces between the contact lines (e.g. a chamfer between two walls) are consumed ' +
    '(data.consumedFaces lists them, data.blends the new blend face). facesA / facesB pick faces by points on them (near) and/or persistent names. ' +
    'Alternatively holdLine { id of a drawn line or polyline lying on one of the two faces, onFaces "A" | "B" } rounds the edge the two faces share with the radius that makes the blend leave that face on the drawn curve (radius = distance to the edge / tan(fold / 2), fold = angle between the outward normals); a conic / curvature profile with a hold line follows the profile rules of fillet_edge (a sloped line is a varying size, which a profile blend takes). ' +
    'profile { type: "conic", rho } or { type: "curvature", shape } changes the section. This kernel build blends ONE planar face per set that end on flat faces square to the blend; BLD_FACE_FILLET_NO_SOLUTION says when no ball of that radius stays in the material (and the smallest radius that does), ' +
    'BLD_FACE_BLEND_UNSUPPORTED what else is not built. Needs the exact native kernel (check kernel_info); with the mesh kernel it no-ops. Run check_blends afterwards.',
  params: z.object({
    id: z.string().describe('Id of the 3D solid entity to blend. Must exist and be a 3D solid kind.'),
    facesA: faceSetSchema.describe('First face set (one planar face in this build).'),
    facesB: faceSetSchema.describe('Second face set (one planar face in this build); must not share a face with facesA.'),
    radius: z.number().describe('Radius of the rolling ball in document units (> 0). Give exactly one of radius or holdLine.').optional(),
    holdLine: z
      .object({
        id: z
          .string()
          .describe('Id of a drawn line or polyline (draw_polyline) lying on the face; its points are in the plane of that face.'),
        onFaces: z.enum(['A', 'B']).describe('Which set the curve lies on: "A" (facesA) or "B" (facesB).'),
      })
      .describe('Hold line: the blend leaves face set `onFaces` on this drawn curve. facesA and facesB must share an edge.')
      .optional(),
    profile: profileSchema.optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, facesA, facesB, radius, holdLine } = params;
    if ((radius === undefined) === (holdLine === undefined))
      return blendRejection(doc, 'fillet_faces', 'BLD_BLEND_PARAMS', 'give exactly one of radius or holdLine', [id], ['radius']);
    if (radius !== undefined && !(radius > 0))
      return blendRejection(doc, 'fillet_faces', 'BLD_LAW_INVALID', `radius must be > 0 (got ${radius})`, [id], ['radius']);
    const profile = resolveProfile(params.profile);
    if (isProfileRefusal(profile)) return blendRejection(doc, 'fillet_faces', profile.code, profile.message, [id], [profile.path]);
    const sets = { facesA, facesB };
    return runFaceBlend(doc, ctx, {
      command: 'fillet_faces',
      id,
      sets,
      describe: (newId, triangles) =>
        `fillet_faces: blended '${id}' (radius ${radius}) → mesh '${newId}' (${triangles} triangles). Source entity consumed.`,
      build: (context) =>
        holdLine !== undefined
          ? holdLineBlend(
              { doc, ctx, id, holdId: holdLine.id, onFaces: holdLine.onFaces, profile: params.profile, facesA, facesB },
              context,
            )
          : {
              recipe: {
                op: 'faceBlend',
                source: context.source,
                facesA: pickedFaces(context, 'facesA'),
                facesB: pickedFaces(context, 'facesB'),
                radius: radius ?? 0,
                ...(profile.profile === undefined ? {} : { profile: profile.profile }),
              },
            },
    });
  },
});
