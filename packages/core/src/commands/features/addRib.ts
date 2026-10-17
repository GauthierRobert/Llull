/**
 * add_rib (07 FTR §4.1, FR-FTR-22): a rib grown from a planar face of a solid — an open polyline path, thickened, raised along the face normal and
 * fused to the part. The result is a `mesh` whose `brep` is a `feature(rib)` node over the target's recipe.
 */

import type { ShapeRecipe, Vec2 } from '../../model/types';
import { is3D } from '../../model/types';
import type { FtrCode } from '../../model/manufacturing';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { commitKernelResult, evaluateRecipe, operandRecipe } from '../brep/kernelShape';
import { noop } from '../noop';
import { frameToWorld, planeFrame } from '../../geometry/featureFrame';
import { thickenedPath } from '../../geometry/featureRib';
import { dot3, len3, scale3 } from '../../lib/vec3';
import { resolveFace } from './faceResolve';
import { POINT_FRAMES, expectedShape, localPoints } from './facePoints';
import { depthToFace } from './holeExtents';
import { refuse } from './ftr';

const SAME_PLANE = 1 - 1e-9;

/**
 * @affects replaces `target` by 1 mesh entity (the part with the rib fused on, `brep` = feature(rib) over the target's recipe)
 * @invariant volume increases by thickness x path length x height (mitred joints); the rib stands entirely on one planar face of the target
 * @failure missing / non-solid target, no kernel, bad plane, path < 2 points / degenerate / self-crossing, thickness or height <= 0, path not on a
 *   supporting planar face, bad up-to face, kernel refusal -> rejected no-op with an FTR_* code
 */
export const addRib = defineCommand({
  name: 'add_rib',
  annotations: { requiresKernel: true },
  description:
    'Grow a rib from a planar face of a 3D solid: an OPEN polyline path (>= 2 points) is thickened by thickness (centred on the path when ' +
    'symmetric, else on its left), raised along the plane normal and fused to the part. plane = { origin: a point on the supporting face, normal: ' +
    'the OUTWARD normal of that face, which is the direction the rib rises }; the path lies on that plane in [u, v] face coordinates (origin = the ' +
    'world origin projected on the plane, u = world X (or Y) projected on it, v = normal x u) or, with pointsFrame "world_xy", world [x, y]. ' +
    'Give exactly one of height (rib height above the plane) or upToFace (stop at the plane of a parallel planar face above it). All lengths ' +
    'are in the document length unit. The rib must stand entirely on the face: otherwise it is refused. Consumes target, creates one mesh ' +
    'entity. Refusals carry error.code: FTR_FACE_NOT_FOUND (no such target), FTR_FACE_NOT_PLANAR, FTR_RIB_PATH_NOT_SUPPORTED, FTR_PROFILE_NOT_CLOSED (bad path), ' +
    'FTR_PARAM_INVALID, FTR_UP_TO_TARGET_INVALID, FTR_FEATURE_BUILD_FAILED. Next: check_machining, inspect_topology.',
  params: z.object({
    target: z.string().describe('Id of the 3D solid to add the rib to (a primitive or a kernel result).'),
    plane: z
      .object({
        origin: vec3('World point [x, y, z] on the supporting planar face, in document length units.'),
        normal: vec3('Outward normal [x, y, z] of the supporting face = the direction the rib rises; any non-zero length (normalised).'),
      })
      .describe('The supporting plane the rib stands on and its rise direction.'),
    path: z
      .array(z.array(z.number()))
      .describe(
        'Open polyline of the rib, >= 2 vertices [u, v] (pointsFrame), in document length units; consecutive vertices distinct, no self-crossing.',
      ),
    pointsFrame: z.enum(POINT_FRAMES).optional().describe('Coordinates of path: "face" (default), "world_xy" or "world" ([x, y, z]).'),
    thickness: z.number().positive().describe('Rib thickness measured across the path, in document length units; must be > 0.'),
    height: z.number().positive().optional().describe('Rib height above the plane, in document length units. Omit with upToFace.'),
    upToFace: z
      .object({ near: vec3('World point [x, y, z] on the planar target face, in document length units.') })
      .optional()
      .describe('Raise the rib up to the plane of this planar face, which must be parallel to the plane and above it. Omit height.'),
    symmetric: z
      .boolean()
      .optional()
      .describe('true (default) = the rib is centred on the path; false = the thickness lies on the left of the path direction (in u, v).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { target, plane, path, pointsFrame = 'face', thickness, height, upToFace, symmetric = true } = params;
    const fail = (code: FtrCode, why: string, remediation: string, ...paths: string[]): CommandResult =>
      refuse(doc, 'add_rib', code, why, remediation, [target], paths);
    const entity = doc.entities[target];
    if (!entity) return fail('FTR_FACE_NOT_FOUND', `entity '${target}' not found`, 'pass an existing 3D solid id', 'target');
    if (!is3D(entity) || entity.kind === 'instance')
      return noop(doc, `add_rib: entity '${target}' (kind '${entity.kind}') is not a 3D solid; explode instances first.`);
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('add_rib'));
    if ((height === undefined) === (upToFace === undefined))
      return fail('FTR_PARAM_INVALID', 'give exactly one of height or upToFace', 'pass height (> 0) or upToFace', 'height', 'upToFace');
    if (!(len3(plane.normal) > 0))
      return fail('FTR_PARAM_INVALID', 'plane.normal has zero length', 'pass the outward normal of the supporting face', 'plane.normal');
    const frame = planeFrame(plane.normal, plane.origin);
    const placed = localPoints(frame, path, pointsFrame);
    const polygon =
      placed.bad.length > 0
        ? `the path points ${placed.bad.join(', ')} are not ${expectedShape[pointsFrame]}`
        : thickenedPath(placed.local, thickness, symmetric);
    if (typeof polygon === 'string')
      return fail('FTR_PROFILE_NOT_CLOSED', polygon, 'pass an open, simple path of >= 2 distinct points', 'path');
    const source = operandRecipe(kernel, entity);
    const start = frameToWorld(frame, placed.local[0] as Vec2);
    const face = resolveFace(kernel, source, start);
    if (face === 'not_found' || face === 'not_planar')
      return fail(
        face === 'not_found' ? 'FTR_RIB_PATH_NOT_SUPPORTED' : 'FTR_FACE_NOT_PLANAR',
        face === 'not_found'
          ? `no face of the target under the path start ${JSON.stringify(start)}`
          : 'the face under the path is not planar',
        'put the path on a planar face of the target (inspect_topology lists faces)',
        'plane',
        'path',
      );
    const sameSide = dot3(face.frame.normal, frame.normal) > SAME_PLANE;
    const offset = dot3(face.frame.normal, face.frame.origin) - dot3(frame.normal, frame.origin);
    const supported =
      sameSide && Math.abs(offset) < 1e-6 * (1 + len3(frame.origin)) && polygon.every((point) => face.contains(frameToWorld(frame, point)));
    if (!supported)
      return fail(
        'FTR_RIB_PATH_NOT_SUPPORTED',
        'the thickened path does not lie entirely on a planar face of the target with the given outward normal',
        'give plane.origin / plane.normal of the supporting face and keep the path (plus half the thickness) inside it',
        'plane',
        'path',
      );
    let rise = height;
    if (upToFace !== undefined) {
      const above = depthToFace(kernel, source, { ...frame, normal: scale3(frame.normal, -1) }, upToFace.near, 'upToFace.near');
      if (typeof above !== 'number') return fail('FTR_UP_TO_TARGET_INVALID', above.why, above.remediation, ...above.paths);
      rise = above;
    }
    const recipe: ShapeRecipe = {
      op: 'feature',
      source,
      feature: 'rib',
      frame,
      rib: { path: placed.local, thickness, height: rise as number, symmetric },
    };
    const result = evaluateRecipe(kernel, recipe);
    if (result === 'refused' || result === 'empty')
      return fail(
        'FTR_FEATURE_BUILD_FAILED',
        `the kernel could not fuse the rib (${result})`,
        'check the solid, the path and the rib size',
      );
    return commitKernelResult(
      doc,
      kernel,
      result,
      [entity],
      (newId, triangles) =>
        `add_rib: fused a ${placed.local.length}-point rib (thickness ${thickness}, height ${rise}, ${symmetric ? 'centred' : 'one-sided'}) onto '${entity.id}'; ` +
        `result mesh '${newId}' (${triangles} triangles). Target consumed.`,
    );
  },
});
