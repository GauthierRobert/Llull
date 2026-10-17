/**
 * add_hole (07 FTR M2): simple / counterbore / countersink holes, through-all or blind with a drill point, at several positions of one planar
 * face of a solid. The result is a `mesh` whose `brep` is a `feature(hole)` node over the target's recipe.
 */

import { type CadDocument, type Entity, is3D } from '../../model/types';
import type { HoleExtent, HoleSpec } from '../../model/features';
import type { GeometryKernel } from '../../geometry/kernel';
import type { ShapeRecipe } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { commitKernelResult, evaluateRecipe, operandRecipe } from '../brep/kernelShape';
import { noop } from '../noop';
import { frameToWorld } from '../../geometry/featureFrame';
import { throughReach } from '../../geometry/featureLowering';
import { type ResolvedFace, resolveFace } from './faceResolve';
import { POINT_FRAMES, expectedShape, localPoints } from './facePoints';
import { buildHole, extentParams, holeParams } from './holeSpec';
import { refuse } from './ftr';

/**
 * @affects replaces `target` by 1 mesh entity (the part with the holes cut, `brep` = feature(hole) over the target's recipe)
 * @invariant volume decreases; one compound tool is cut for all positions; `hole.thread` and `hole.fastener` never change the geometry
 * @failure missing / non-solid target, no kernel, face not found / not planar, any point outside the face, inconsistent diameters, bad
 *   countersink angle, bad blind depth, bad thread designation, fastener without catalogue, kernel refusal -> rejected no-op with an FTR_* code
 */
export const addHole = defineCommand({
  name: 'add_hole',
  annotations: { requiresKernel: true },
  description:
    'Cut holes into a planar face of a 3D solid: simple, counterbore or countersink; through the whole part (through_all) or blind with a ' +
    'drill point (default 118 degrees, reported as defaulted; drillPointAngle 0 = flat bottom). The face is picked by a world point on it ' +
    '(face.near); the holes go INTO the material, along the opposite of the face outward normal. All lengths are in the document length ' +
    'unit, all angles in degrees. points: [u, v] in the face frame (origin = the world origin projected on the face plane, u = world X ' +
    '(or Y) projected on it, v = normal x u), or pointsFrame "world_xy" ([x, y] world, the point is moved along Z onto the face), or ' +
    '"world" ([x, y, z] projected onto the face). All positions are validated first: if one is bad nothing is cut. hole.thread is a ' +
    'cosmetic attribute (geometry unchanged). hole.fastener takes the clearance diameter from the document fastener catalogue. Consumes ' +
    'target and creates one mesh entity (exact B-rep with an exact kernel). Refusals carry error.code: FTR_FACE_NOT_FOUND, ' +
    'FTR_FACE_NOT_PLANAR, FTR_HOLE_POINT_OUTSIDE_FACE, FTR_HOLE_DIAMETERS_INCONSISTENT, FTR_CSK_ANGLE_OUT_OF_RANGE, FTR_BLIND_DEPTH_INVALID, ' +
    'FTR_DRILL_POINT_ANGLE_OUT_OF_RANGE, FTR_THREAD_DESIGNATION_INVALID, FTR_FASTENER_CATALOG_UNAVAILABLE, FTR_FEATURE_BUILD_FAILED. ' +
    'Next: check_machining, hole_table, recognize_features.',
  params: z.object({
    target: z.string().describe('Id of the 3D solid to drill (a primitive or a kernel result).'),
    face: z
      .object({ near: vec3('World point [x, y, z] on (or within 0.1% of the part size of) the planar face, in document length units.') })
      .describe('The planar face to drill into, picked by a world point.'),
    points: z
      .array(z.array(z.number()))
      .min(1)
      .describe('Hole centres, in document length units: [u, v] (pointsFrame face), [x, y] (world_xy) or [x, y, z] (world). At least one.'),
    pointsFrame: z
      .enum(POINT_FRAMES)
      .optional()
      .describe('Coordinates of points: "face" (default), "world_xy" or "world". See the command description.'),
    hole: holeParams,
    extent: extentParams,
  }),
  run: (doc, { target, face, points, pointsFrame = 'face', hole, extent }, ctx): CommandResult => {
    const entity = doc.entities[target];
    if (!entity)
      return refuse(
        doc,
        'add_hole',
        'FTR_FACE_NOT_FOUND',
        `entity '${target}' not found`,
        'pass an existing 3D solid id',
        [target],
        ['target'],
      );
    if (!is3D(entity) || entity.kind === 'instance')
      return noop(doc, `add_hole: entity '${target}' (kind '${entity.kind}') is not a 3D solid; explode instances first.`);
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('add_hole'));
    const built = buildHole(doc, hole, extent);
    if ('code' in built) return refuse(doc, 'add_hole', built.code, built.why, built.remediation, [target], built.paths);
    const source = operandRecipe(kernel, entity);
    const resolved = resolveFace(kernel, source, face.near);
    if (resolved === 'not_found' || resolved === 'not_planar')
      return refuse(
        doc,
        'add_hole',
        resolved === 'not_found' ? 'FTR_FACE_NOT_FOUND' : 'FTR_FACE_NOT_PLANAR',
        resolved === 'not_found' ? `no face within reach of face.near ${JSON.stringify(face.near)}` : 'the picked face is not planar',
        'pick a point on a planar face (inspect_topology lists faces)',
        [target],
        ['face.near'],
      );
    return drill(doc, kernel, entity, source, resolved, points, pointsFrame, built.hole, built.extent, built.notes);
  },
});

function drill(
  doc: CadDocument,
  kernel: GeometryKernel,
  entity: Entity,
  source: ShapeRecipe,
  resolved: ResolvedFace,
  points: ReadonlyArray<readonly number[]>,
  pointsFrame: (typeof POINT_FRAMES)[number],
  hole: HoleSpec,
  extent: HoleExtent,
  notes: readonly string[],
): CommandResult {
  const { frame } = resolved;
  const { local, bad } = localPoints(frame, points, pointsFrame);
  if (bad.length > 0)
    return refuse(
      doc,
      'add_hole',
      'FTR_HOLE_POINT_OUTSIDE_FACE',
      `points ${bad.join(', ')} are not ${expectedShape[pointsFrame]}`,
      'keep hole centres inside the face outline, in the stated pointsFrame',
      [entity.id],
      bad.map((index) => `points.${index}`),
    );
  const outside = local.flatMap((point, index) => (resolved.contains(frameToWorld(frame, point)) ? [] : [index]));
  if (outside.length > 0)
    return refuse(
      doc,
      'add_hole',
      'FTR_HOLE_POINT_OUTSIDE_FACE',
      `points ${outside.join(', ')} lie outside the picked face`,
      'keep hole centres inside the face outline',
      [entity.id],
      outside.map((index) => `points.${index}`),
    );
  if (extent.kind === 'blind') {
    const shape = kernel.evaluate(source);
    const mesh = shape === null ? null : kernel.tessellate(shape);
    if (mesh !== null && extent.depth >= throughReach(mesh, frame))
      return refuse(
        doc,
        'add_hole',
        'FTR_BLIND_DEPTH_INVALID',
        `blind depth ${extent.depth} reaches or exceeds the stock below the face (${throughReach(mesh, frame)})`,
        'use through_all, or a depth inside the material',
        [entity.id],
        ['extent.depth'],
      );
  }
  const recipe: ShapeRecipe = { op: 'feature', source, feature: 'hole', frame, points: local, hole, extent };
  const result = evaluateRecipe(kernel, recipe);
  if (result === 'refused' || result === 'empty')
    return refuse(
      doc,
      'add_hole',
      'FTR_FEATURE_BUILD_FAILED',
      `the kernel could not cut the holes (${result})`,
      'check the solid and the hole sizes with inspect_topology',
      [entity.id],
    );
  const label = `${local.length} ${hole.kind} hole${local.length === 1 ? '' : 's'} Ø${hole.diameter}`;
  const detail = [
    hole.cskDiameter === undefined ? '' : `, countersink Ø${hole.cskDiameter} ${hole.cskAngle}°`,
    hole.cboreDiameter === undefined ? '' : `, counterbore Ø${hole.cboreDiameter} x ${hole.cboreDepth}`,
    extent.kind === 'blind'
      ? `, blind ${extent.depth}${extent.drillPointAngle === undefined ? ' flat' : ` + ${extent.drillPointAngle}° point`}`
      : ', through all',
    hole.thread === undefined ? '' : `, thread ${hole.thread.designation} (cosmetic)`,
  ].join('');
  const facts = notes.length === 0 ? '' : ` Note: ${notes.join('; ')}.`;
  const normal = frame.normal.map((c) => Math.round(c * 1e6) / 1e6).join(', ');
  const next = commitKernelResult(
    doc,
    kernel,
    result,
    [entity],
    (newId, triangles) =>
      `add_hole: cut ${label}${detail} into '${entity.id}' along -[${normal}]; result mesh '${newId}' (${triangles} triangles). Target consumed.${facts}`,
  );
  return next;
}
