/**
 * Face operations on an exact B-rep (SC-F1): draft, push-pull, split face and replace face. One `faceOp` recipe node each, built by the
 * native OCC kernel; faces are picked by index, point or persistent name (recorded for regeneration, SC-N1).
 */

import { round6 } from '../../lib/compactNumber';
import type { Vec3 } from '../../model/types';
import type { PlaneSpec } from '../../model/faceOps';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { dot3, normalize3, sub3 } from '../../lib/vec3';
import { planarFace, runFaceOp, type FaceOpContext } from './faceOpRun';

const faceIndices = z
  .array(z.number().int().nonnegative())
  .describe('0-based unique face indices (inspect_topology / inspect_faces).')
  .optional();
const facesNear = z
  .array(vec3('A point [x, y, z] on the face (its nearest face is taken).'))
  .describe('Faces picked by location: each point takes the face nearest to it.')
  .optional();
const faceNames = z
  .array(z.string().min(1))
  .describe(
    'Persistent face names (inspect_topology on the native kernel): recorded automatically from the first pick and used on regeneration; a name that is gone or split refuses the step (REF_LOST / REF_SPLIT).',
  )
  .optional();
const planeSchema = z
  .object({ origin: vec3('A point [x, y, z] on the plane.'), normal: vec3('Plane normal [x, y, z] (any length > 0).') })
  .describe('A plane by a point and its normal.');

const DEFAULT_PULL: Vec3 = [0, 0, 1];
const degrees = (radians: number): string => `${round6((radians * 180) / Math.PI)}°`;
const unit = (v: Vec3): Vec3 | null => (Math.hypot(...v) > 0 ? normalize3(v) : null);

/** Lowest point of the solid along `direction` (the default neutral plane of a draft: the parting line at the bottom). */
function lowestAlong(context: FaceOpContext, direction: Vec3): Vec3 | null {
  const mesh = context.kernel.tessellate(context.shape);
  if (mesh === null) return null;
  let best: Vec3 | null = null;
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    const point: Vec3 = [mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0];
    if (best === null || dot3(point, direction) < dot3(best, direction)) best = point;
  }
  return best;
}

/**
 * @affects removes source entity; creates 1 mesh entity whose picked faces are tilted by the draft angle
 * @failure no exact kernel, bad face pick, angle not in (0, 89] degrees, pull zero, kernel refusal -> no-op
 */
export const draftFaces = defineCommand({
  name: 'draft_faces',
  annotations: { requiresKernel: true },
  description:
    'Draft (taper) faces of a 3D solid for mould release: each picked face is tilted by angle degrees about its intersection with the neutral ' +
    'plane so the part opens along pull. Pick faces by faceIndices, facesNear or faceNames. The neutral plane defaults to the plane normal to ' +
    'pull through the lowest point of the solid (the parting line at the bottom). Exact B-rep only (native OCC kernel); the source is consumed.',
  params: z.object({
    id: z.string().describe('Id of the 3D solid.'),
    faceIndices,
    facesNear,
    faceNames,
    angle: z.number().describe('Draft angle in degrees, 0 < |angle| <= 89 (positive opens the part along pull).'),
    pull: vec3('Pull (mould opening) direction [x, y, z]. Default [0, 0, 1].').optional(),
    neutralPlane: planeSchema.optional(),
  }),
  run: (doc, { id, faceIndices: indices = [], facesNear: near = [], faceNames: names, angle, pull, neutralPlane }, ctx): CommandResult =>
    runFaceOp(doc, ctx, {
      command: 'draft_faces',
      id,
      pick: { indices, near, names },
      build: (context) => {
        if (!(Math.abs(angle) > 0 && Math.abs(angle) <= 89)) return `angle must be in (0, 89] degrees (got ${angle})`;
        const direction = unit(pull ?? DEFAULT_PULL);
        if (direction === null) return 'pull must be a non-zero direction';
        const origin = neutralPlane?.origin ?? lowestAlong(context, direction);
        const normal = neutralPlane === undefined ? direction : unit(neutralPlane.normal);
        if (origin === null || normal === null) return 'neutralPlane must have a non-zero normal';
        return { kind: 'draft', faces: [...context.faces], angle: (angle * Math.PI) / 180, pull: direction, neutral: { origin, normal } };
      },
      describe: (params) => (params.kind === 'draft' ? `drafted ${params.faces.length} face(s) by ${degrees(params.angle)}` : 'drafted'),
    }),
});

/**
 * @affects removes source entity; creates 1 mesh entity with the planar face moved along its normal
 * @failure no exact kernel, not exactly one planar face, distance 0, kernel refusal -> no-op
 */
export const pushPullFace = defineCommand({
  name: 'push_pull_face',
  annotations: { requiresKernel: true },
  description:
    'Push or pull ONE planar face of a 3D solid along its outward normal: distance > 0 adds material (the face moves out, its side faces ' +
    'follow), distance < 0 removes it. Pick the face by faceIndex, faceNear or faceName. Exact B-rep only (native OCC kernel); the source is consumed.',
  params: z.object({
    id: z.string().describe('Id of the 3D solid.'),
    faceIndex: z.number().int().nonnegative().describe('0-based unique face index (inspect_faces).').optional(),
    faceNear: vec3('A point [x, y, z] on the face.').optional(),
    faceName: z.string().min(1).describe('Persistent face name (recorded automatically; see faceNames of draft_faces).').optional(),
    distance: z.number().describe('Offset along the outward face normal in document units (non-zero; negative cuts into the solid).'),
  }),
  run: (doc, { id, faceIndex, faceNear, faceName, distance }, ctx): CommandResult =>
    runFaceOp(doc, ctx, {
      command: 'push_pull_face',
      id,
      pick: {
        indices: faceIndex === undefined ? [] : [faceIndex],
        near: faceNear === undefined ? [] : [faceNear],
        names: faceName === undefined ? undefined : [faceName],
      },
      build: (context) => pushPullParams(context, distance),
      describe: (params) => (params.kind === 'pushPull' ? `moved face ${params.faces[0]} by ${params.distance}` : 'moved'),
    }),
});

function pushPullParams(context: FaceOpContext, distance: number): ReturnType<Parameters<typeof runFaceOp>[2]['build']> {
  const [face, extra] = context.faces;
  if (face === undefined || extra !== undefined) return 'pick exactly one face';
  if (!Number.isFinite(distance) || distance === 0) return `distance must be finite and non-zero (got ${distance})`;
  const plane = planarFace(context, face);
  return typeof plane === 'string' ? plane : { kind: 'pushPull', faces: [face], distance };
}

/**
 * @affects removes source entity; creates 1 mesh entity whose picked faces are cut in two along the plane
 * @failure no exact kernel, bad face pick, zero plane normal, kernel refusal -> no-op
 */
export const splitFace = defineCommand({
  name: 'split_face',
  annotations: { requiresKernel: true },
  description:
    'Split faces of a 3D solid along a plane (the body stays one solid; each picked face crossing the plane becomes two faces, e.g. to draft ' +
    'or push-pull only part of a face). Pick faces by faceIndices, facesNear or faceNames. Exact B-rep only (native OCC kernel).',
  params: z.object({ id: z.string().describe('Id of the 3D solid.'), faceIndices, facesNear, faceNames, plane: planeSchema }),
  run: (doc, { id, faceIndices: indices = [], facesNear: near = [], faceNames: names, plane }, ctx): CommandResult =>
    runFaceOp(doc, ctx, {
      command: 'split_face',
      id,
      pick: { indices, near, names },
      build: (context) => {
        const normal = unit(plane.normal);
        return normal === null
          ? 'plane.normal must be non-zero'
          : { kind: 'splitFace', faces: [...context.faces], plane: { origin: plane.origin, normal } };
      },
      describe: (params) => `split ${params.faces.length} face(s)`,
    }),
});

/** The planar target of replace_face: a plane given directly. */
function replaceParams(context: FaceOpContext, target: PlaneSpec): ReturnType<Parameters<typeof runFaceOp>[2]['build']> {
  const [face, extra] = context.faces;
  if (face === undefined || extra !== undefined) return 'pick exactly one face';
  const plane = planarFace(context, face);
  if (typeof plane === 'string') return plane;
  const normal = unit(target.normal);
  if (normal === null) return 'target.normal must be non-zero';
  if (Math.abs(dot3(normal, plane.normal)) < 1 - 1e-6)
    return 'the target plane is not parallel to the face (replace_face moves a planar face onto a parallel plane; use draft_faces to tilt it)';
  const distance = dot3(sub3(target.origin, plane.point), plane.normal);
  if (Math.abs(distance) < 1e-9) return 'the face already lies on the target plane';
  return { kind: 'pushPull', faces: [face], distance };
}

/**
 * @affects removes source entity; creates 1 mesh entity whose planar face lies on the target plane
 * @failure no exact kernel, not one planar face, target not parallel, face already on target, kernel refusal -> no-op
 */
export const replaceFace = defineCommand({
  name: 'replace_face',
  annotations: { requiresKernel: true },
  description:
    'Replace a planar face of a 3D solid by a parallel target plane: the face moves onto the plane and its side faces follow (e.g. bring a ' +
    'boss up to a datum, or flush a face with another part). The target is a plane { origin, normal } parallel to the face (copy it from ' +
    'inspect_faces of the other part). Pick the face by faceIndex, faceNear or faceName. Exact B-rep only (native OCC kernel).',
  params: z.object({
    id: z.string().describe('Id of the 3D solid.'),
    faceIndex: z.number().int().nonnegative().describe('0-based unique face index (inspect_faces).').optional(),
    faceNear: vec3('A point [x, y, z] on the face.').optional(),
    faceName: z.string().min(1).describe('Persistent face name (recorded automatically).').optional(),
    target: planeSchema,
  }),
  run: (doc, { id, faceIndex, faceNear, faceName, target }, ctx): CommandResult =>
    runFaceOp(doc, ctx, {
      command: 'replace_face',
      id,
      pick: {
        indices: faceIndex === undefined ? [] : [faceIndex],
        near: faceNear === undefined ? [] : [faceNear],
        names: faceName === undefined ? undefined : [faceName],
      },
      build: (context) => replaceParams(context, target),
      describe: (params) =>
        params.kind === 'pushPull' ? `moved face ${params.faces[0]} onto the target plane (${params.distance})` : 'replaced',
    }),
});
