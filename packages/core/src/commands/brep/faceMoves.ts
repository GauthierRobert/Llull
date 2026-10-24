/**
 * Direct face moves on an exact B-rep (04 DIR M6): move_faces (offset / translate / rotate) and delete_faces. One `faceOp` recipe node each, built
 * by the native OCC kernel; faces are picked by index, point or persistent name exactly like the other face operations.
 */

import type { Vec3 } from '../../model/types';
import type { FaceMove } from '../../model/faceOps';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { tableRejection } from '../noop';
import { runFaceOp, type FaceOpContext } from './faceOpRun';

const FACE_MOVE_REMEDIATION: Readonly<Record<string, string>> = {
  DIR_FACE_MOVE_PARAMS:
    'Give the parameters of the chosen mode: translate needs vector, rotate needs axis and angleDeg (a planar face rotates by less than 85 degrees), offset needs distance.',
  DIR_FACE_MOVE_FAILED:
    'Move a smaller distance / angle, or pick the adjacent faces of the same feature together; mode "offset" is the most robust for bores and bosses.',
  DIR_FACE_MOVE_TOPOLOGY:
    'The face would vanish or turn inside out: reduce the distance (a cylinder or sphere needs radius + distance > 0).',
  DIR_DEFEATURE_FAILED: 'Delete every face of the feature together (a fillet chain, all faces of a hole or boss); then retry.',
};
const refuseMove = tableRejection(FACE_MOVE_REMEDIATION);

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

/** Largest rotation of one planar face (radians): the native draft stops just above it. */
const PLANAR_ROTATION_LIMIT = (85 * Math.PI) / 180;

/** The pick is one planar face (so a rotation is a draft of its plane rather than a feature move). */
function planarPick(context: FaceOpContext): boolean {
  const details = context.kernel.faceQuery?.faceDetails(context.shape, { samples: 0 }) ?? null;
  return context.faces.length === 1 && details?.[context.faces[0] as number]?.surface === 'plane';
}

const unit = (v: Vec3): Vec3 | null => {
  const length = Math.hypot(...v);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : null;
};

/** Smallest radius a round face would reach after a radial offset, or null when no face of the pick has an exact radius. */
function offsetTopologyProblem(context: FaceOpContext, distance: number): string | null {
  const details = context.kernel.faceQuery?.faceDetails(context.shape, { samples: 0 }) ?? null;
  for (const face of context.faces) {
    const detail = details?.[face];
    if (detail === undefined || detail.radius === undefined) continue;
    if (detail.surface === 'cylinder' || detail.surface === 'sphere') {
      if (detail.radius + distance <= 1e-9)
        return `face ${face} is ${detail.surface} of radius ${detail.radius}: an offset of ${distance} would remove it`;
    }
  }
  return null;
}

/**
 * @affects removes source entity; creates 1 mesh entity with the picked faces moved
 * @invariant kernel-bound (requiresKernel): the result is ONE valid closed solid (BRepCheck) or the step is refused; picked faces are recorded by persistent name; a moved face keeps its name; data { volumeBefore, volumeAfter } are the exact kernel volumes
 * @failure no exact kernel, bad face pick, missing mode parameters (DIR_FACE_MOVE_PARAMS), a round face that would vanish (DIR_FACE_MOVE_TOPOLOGY), OCC cannot rebuild a valid solid (DIR_FACE_MOVE_FAILED) -> no-op
 */
export const moveFaces = defineCommand({
  name: 'move_faces',
  annotations: { requiresKernel: true },
  description:
    'Move faces of an imported or built B-rep directly, without its history (direct editing). Pick the faces by faceIndices, facesNear or faceNames. mode ' +
    '"offset" (`distance`, document units): every picked face moves along its surface normal - a plane along its outward normal (positive adds material), a ' +
    'cylinder / cone / sphere / torus AWAY from its axis or centre (a bore widens, a boss thickens); the neighbouring faces extend or shrink to meet the moved ones (drafted and obtuse neighbours, adjacent picked faces) ' +
    '(BRepOffset_MakeOffset, intersection join). mode "translate" (`vector` [x, y, z]): one planar face moves by the component of the vector along its normal (the in-plane part changes ' +
    'nothing), any other pick is a FEATURE (a hole, a boss, a pocket: pick all its faces) that is moved rigidly to the new place. mode "rotate" (`axis` ' +
    '{ origin, direction } and `angleDeg`, |angle| < 85 for a planar face): a planar face tilts to its rotated plane with the neighbours extending; any other ' +
    'pick is a feature rotated rigidly. Exact B-rep only (native OCC kernel); the source is consumed and the result must be one valid solid. Returns data ' +
    '{ volumeBefore, volumeAfter, volumeUnit, faces }. Refuses missing mode parameters (DIR_FACE_MOVE_PARAMS), a cylinder or sphere that would vanish ' +
    '(DIR_FACE_MOVE_TOPOLOGY) and a move OCC cannot rebuild (DIR_FACE_MOVE_FAILED). Next: mass_properties, inspect_topology, delete_faces.',
  params: z.object({
    id: z.string().describe('Id of the 3D solid.'),
    faceIndices,
    facesNear,
    faceNames,
    mode: z
      .enum(['translate', 'rotate', 'offset'])
      .describe('How the faces move: "offset" along the surface normal, "translate" by a vector, "rotate" about an axis.'),
    vector: vec3('translate: displacement [x, y, z] in document units (non-zero).').optional(),
    axis: z
      .object({ origin: vec3('A point [x, y, z] on the rotation axis.'), direction: vec3('Axis direction [x, y, z] (any length > 0).') })
      .describe('rotate: the rotation axis.')
      .optional(),
    angleDeg: z
      .number()
      .describe('rotate: angle in degrees, positive counter-clockwise about the axis direction (non-zero, below 180).')
      .optional(),
    distance: z.number().describe('offset: signed distance in document units along the surface normal (non-zero).').optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, mode, vector, axis, angleDeg, distance } = params;
    const refuse = (code: string, message: string, path: string): CommandResult =>
      refuseMove(doc, 'move_faces', code, message, [id], [`params.${path}`]);
    let move: FaceMove;
    if (mode === 'translate') {
      if (vector === undefined || unit(vector) === null)
        return refuse('DIR_FACE_MOVE_PARAMS', 'translate needs a non-zero vector', 'vector');
      move = { type: 'translate', vector };
    } else if (mode === 'rotate') {
      const direction = axis === undefined ? null : unit(axis.direction);
      if (axis === undefined || direction === null)
        return refuse('DIR_FACE_MOVE_PARAMS', 'rotate needs an axis with a non-zero direction', 'axis');
      if (angleDeg === undefined || !Number.isFinite(angleDeg) || angleDeg === 0 || Math.abs(angleDeg) >= 180)
        return refuse('DIR_FACE_MOVE_PARAMS', 'rotate needs angleDeg that is non-zero and below 180', 'angleDeg');
      move = { type: 'rotate', axis: { origin: axis.origin, direction }, angle: (angleDeg * Math.PI) / 180 };
    } else {
      if (distance === undefined || !Number.isFinite(distance) || distance === 0)
        return refuse('DIR_FACE_MOVE_PARAMS', 'offset needs a non-zero distance', 'distance');
      move = { type: 'offset', distance };
    }
    return runFaceOp(doc, ctx, {
      command: 'move_faces',
      id,
      pick: { indices: params.faceIndices ?? [], near: params.facesNear ?? [], names: params.faceNames },
      build: (context) => {
        const problem = move.type === 'offset' ? offsetTopologyProblem(context, move.distance) : null;
        if (move.type === 'rotate' && Math.abs(move.angle) >= PLANAR_ROTATION_LIMIT && planarPick(context))
          return {
            code: 'DIR_FACE_MOVE_PARAMS',
            message: 'a planar face rotates by less than 85 degrees (the draft behind it stops there)',
          };
        return problem === null
          ? { kind: 'moveFaces', faces: [...context.faces], move }
          : { code: 'DIR_FACE_MOVE_TOPOLOGY', message: problem };
      },
      describe: (node) => `${mode} ${node.faces.length} face(s)`,
      kernelFailure: { code: 'DIR_FACE_MOVE_FAILED', remediation: FACE_MOVE_REMEDIATION['DIR_FACE_MOVE_FAILED'] as string },
      reportVolume: true,
      coded: (code, message) => refuseMove(doc, 'move_faces', code, message, [id], []),
    });
  },
});

/**
 * @affects removes source entity; creates 1 mesh entity without the picked faces (the neighbours extend to close the gap)
 * @invariant kernel-bound (requiresKernel): the result is ONE valid closed solid or the step is refused; surviving faces keep their persistent names; data { volumeBefore, volumeAfter } are the exact kernel volumes
 * @failure no exact kernel, bad face pick, OCC defeaturing not done or not one valid solid (DIR_DEFEATURE_FAILED) -> no-op
 */
export const deleteFaces = defineCommand({
  name: 'delete_faces',
  annotations: { requiresKernel: true },
  description:
    'Delete faces of a B-rep and heal the gap (defeaturing): a fillet or chamfer disappears and the edge is sharp again, a hole is filled, a boss or pocket ' +
    'vanishes - the neighbouring faces extend until they meet. Pick ALL faces of the feature (a fillet chain, a hole wall and its countersink) by faceIndices, ' +
    'facesNear or faceNames. Exact B-rep only (native OCC kernel; inputs must be solids); the source is consumed and the result must be one valid solid. ' +
    'Returns data { volumeBefore, volumeAfter, volumeUnit, faces }. Refuses what OCC cannot heal (DIR_DEFEATURE_FAILED, e.g. an unclosed gap or a face that has ' +
    'no neighbours to extend). Next: mass_properties, inspect_topology, move_faces.',
  params: z.object({ id: z.string().describe('Id of the 3D solid.'), faceIndices, facesNear, faceNames }),
  run: (doc, { id, faceIndices: indices = [], facesNear: near = [], faceNames: names }, ctx): CommandResult =>
    runFaceOp(doc, ctx, {
      command: 'delete_faces',
      id,
      pick: { indices, near, names },
      build: (context) => ({ kind: 'deleteFaces', faces: [...context.faces] }),
      describe: (node) => `delete ${node.faces.length} face(s)`,
      kernelFailure: { code: 'DIR_DEFEATURE_FAILED', remediation: FACE_MOVE_REMEDIATION['DIR_DEFEATURE_FAILED'] as string },
      reportVolume: true,
    }),
});
