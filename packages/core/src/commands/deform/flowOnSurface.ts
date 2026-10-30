/** flow_on_surface — wrap a flat-designed body onto a curved target surface, keeping its arc lengths (01 DEF M4, FR-DEF-15, Rhino FlowAlongSrf / CATIA Wrap Surface). */

import type { CadDocument, Vec3 } from '../../model/types';
import { buildFlowSurface } from '../../geometry/deform/flowSurface';
import { worldSurface } from '../../geometry/deform/worldNurbs';
import { hasMeshLeaf } from '../../geometry/operandRecipe';
import { recipeOf } from '../../geometry/shapeRecipe';
import type { GeometryKernel } from '../../geometry/kernel';
import { closestOnSurface } from '../../lib/nurbs/closest';
import { surfaceDerivatives } from '../../lib/nurbs/surface';
import { interpolateGrid } from '../../lib/nurbs/surfaceFit';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { cross3, dot3, len3, normalize3 } from '../../lib/vec3';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { bodyParams, outputParam, targetIds } from './schema';
import type { DeformPlan } from './request';
import { runDeform } from './run';
import { type Refusal, defaultTolerance, resolveTargetFrame } from './target';

/** The target surface in world coordinates and which side its normal points to. */
interface TargetSurface {
  readonly surface: NurbsSurfaceData;
  /** +1: the normal is S_u x S_v, -1: the opposite (a face of a solid: outward). */
  readonly side: 1 | -1;
}

/** Samples per direction of the grid a face is read on (its exact points, interpolated by a bicubic patch: ~1e-7 relative on a circular arc). */
const FACE_GRID = 65;

/**
 * The nearest face of the solid `entityId` to `near` as a B-spline sheet (the exact face sampled on a grid and interpolated), with the sign that makes its
 * normal point out of the solid.
 */
function faceTarget(doc: CadDocument, kernel: GeometryKernel | null, entityId: string, near: Vec3): TargetSurface | Refusal {
  const entity = doc.entities[entityId];
  if (entity === undefined)
    return { code: 'DEF_FLOW_TARGET_INVALID', message: `target entity '${entityId}' not found`, paths: ['params.target.entityId'] };
  if (kernel === null || kernel.faceQuery === undefined)
    return {
      code: 'DEF_TARGET_FACE_NEEDS_KERNEL',
      message:
        'a face of a solid is read through the exact kernel (native kernel); no exact kernel is installed. Use a sheet target (nurbs_surface) instead',
      paths: ['params.target'],
    };
  const invalid = (message: string): Refusal => ({ code: 'DEF_FLOW_TARGET_INVALID', message, paths: ['params.target.faceNear'] });
  const recipe = recipeOf(entity);
  if (hasMeshLeaf(recipe))
    return invalid(
      `entity '${entityId}' is built on a mesh without an exact construction: a face target needs a solid with exact B-rep faces`,
    );
  const shape = kernel.evaluate(recipe);
  const topology = shape === null ? null : kernel.topology(shape);
  if (shape === null || topology === null) return invalid(`entity '${entityId}' has no exact B-rep faces`);
  const query = kernel.faceQuery;
  let best: { face: number; distance: number; normal: Vec3 } | null = null;
  for (let face = 0; face < topology.faces.length; face++) {
    const hit = query.projectOnFace(shape, face, [near])?.[0];
    if (hit !== null && hit !== undefined && (best === null || hit.distance < best.distance))
      best = { face, distance: hit.distance, normal: hit.normal };
  }
  const bounds = best === null ? null : query.faceGeometry(shape, best.face)?.uvBounds;
  if (best === null || bounds === null || bounds === undefined) return invalid(`no usable face of '${entityId}' near [${near.join(', ')}]`);
  const [[u0, v0], [u1, v1]] = bounds;
  const uv: Array<readonly [number, number]> = [];
  for (let i = 0; i < FACE_GRID; i++)
    for (let j = 0; j < FACE_GRID; j++) uv.push([u0 + ((u1 - u0) * i) / (FACE_GRID - 1), v0 + ((v1 - v0) * j) / (FACE_GRID - 1)]);
  const samples = query.evaluateFace(shape, best.face, uv);
  if (samples === null || samples.length !== uv.length) return invalid(`the face of '${entityId}' could not be sampled`);
  const grid = Array.from({ length: FACE_GRID }, (_, i) =>
    Array.from({ length: FACE_GRID }, (_, j) => (samples[i * FACE_GRID + j] as { point: Vec3 }).point),
  );
  const fit = interpolateGrid(grid, 3, 3);
  if ('code' in fit) return invalid(`the face of '${entityId}' could not be fitted: ${fit.message}`);
  const middle = samples[Math.floor((FACE_GRID * FACE_GRID) / 2)] as { point: Vec3; normal: Vec3 };
  const foot = closestOnSurface(fit.surface, middle.point);
  const derivatives = surfaceDerivatives(fit.surface, foot.u, foot.v, 1);
  const raw = cross3((derivatives[1] as Vec3[])[0] as Vec3, (derivatives[0] as Vec3[])[1] as Vec3);
  return { surface: fit.surface, side: dot3(raw, middle.normal) >= 0 ? 1 : -1 };
}

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node with a surface-flow law (a table of the target positions and normals)
 * @invariant arc lengths along the iso-curves through the target origin are kept, w is the offset along the target normal, det J = (1 - w k1)(1 - w k2) x (area ratio):
 *   on a cylinder of radius R a plate of thickness t outside has volume W H (t + t^2 / (2 R)); kernel-optional: exact warp on the native kernel, mesh path otherwise;
 *   a face target needs the exact kernel
 * @failure target missing / not a sheet or a face / a face of a body built on an imported mesh -> DEF_FLOW_TARGET_INVALID; a face without the exact kernel -> DEF_TARGET_FACE_NEEDS_KERNEL; the body leaves a
 *   non-closed target -> DEF_FLOW_OUTSIDE_BASE; wraps past a closed target's period -> DEF_FLOW_OVERLAP; w inside the radius of curvature -> DEF_FOLDOVER
 */
export const flowOnSurface = defineCommand({
  name: 'flow_on_surface',
  annotations: { readsMeshTriangles: true },
  description:
    'Wrap a body designed flat (a plate, an embossed logo, a rib) onto a curved target surface. The base is a plane (origin, normal, uDirection): the body x axis is uDirection, ' +
    'y is normal x uDirection, w is the offset along the normal. The point (x, y, w) goes to S(u*, v*) + w N(u*, v*) on the target, where x and y are ARC LENGTHS on the target ' +
    'measured from targetOrigin along the surface direction closest to targetUDirection (x) and the perpendicular one (y), and N is the target normal (a face of a solid: pointing out of the solid; ' +
    'a sheet: S_u x S_v, reversed by flipNormal). Lengths are kept along both directions at the origin; the material is stretched or squeezed by (R + w) / R on a cylinder of radius R ' +
    '(a plate W x H x t laid outside a drum has volume W H (t + t^2 / (2 R)), about 4 percent more than flat for t 2, R 30). ' +
    'target is {sheetId} (a nurbs_surface, any kernel) or {entityId, faceNear} (the face of a solid nearest to the world point faceNear; needs the native exact kernel). ' +
    'The result replaces the entity as a mesh entity that keeps the construction (brep recipe). Refuses a missing or unusable target (DEF_FLOW_TARGET_INVALID), a face without the ' +
    'exact kernel (DEF_TARGET_FACE_NEEDS_KERNEL), a body that leaves the target (DEF_FLOW_OUTSIDE_BASE), a body longer than the closed circumference of the target ' +
    '(DEF_FLOW_OVERLAP) and a body reaching inside the radius of curvature (DEF_FOLDOVER). Then call analyze_deformation and check_deformation.',
  params: z.object({
    ...bodyParams,
    base: z
      .object({
        plane: z
          .object({
            origin: vec3('A point of the base plane, world document units (the body x, y are measured from it).'),
            normal: vec3(
              'Normal of the base plane, unitless (normalised): the direction of the offset w. The body sits on its positive side to be laid outside the target.',
            ),
            uDirection: vec3('Direction of the body x axis in the plane, unitless; its component perpendicular to normal is used.'),
          })
          .describe('The base plane: origin, normal and uDirection.'),
      })
      .describe('The flat reference the body is laid out on: a plane. (A curved base sheet is not supported.)'),
    target: z
      .object({
        sheetId: z.string().describe('Id of a nurbs_surface entity to flow onto. Give this or entityId with faceNear.').optional(),
        entityId: z
          .string()
          .describe('Id of a solid whose face is the target (needs the native exact kernel). Give with faceNear.')
          .optional(),
        faceNear: vec3('World point near the wanted face of entityId; the nearest face is used.').optional(),
      })
      .describe('The surface the body is wrapped onto: a sheet, or a face of a solid.'),
    targetOrigin: vec3(
      'World point on the target that the base origin goes to (its projection onto the target is used). Default: the point of the target nearest to the base origin.',
    ).optional(),
    targetUDirection: vec3(
      'World direction on the target that the body x axis follows (its tangent component picks the iso-direction). Default: the base uDirection.',
    ).optional(),
    flipNormal: z
      .boolean()
      .describe(
        'true: put the body on the other side of a sheet target (reverses N). Default false; a face target always uses the outward side.',
      )
      .optional(),
    output: outputParam.optional(),
  }),
  run: (
    doc,
    { id, ids, keepSource, base, target: where, targetOrigin, targetUDirection, flipNormal = false, output },
    ctx,
  ): CommandResult =>
    runDeform(doc, ctx, {
      command: 'flow_on_surface',
      ids: targetIds(id, ids),
      keepSource,
      verb: 'wrapped onto a surface',
      output,
      plan: (target): DeformPlan | Refusal => {
        const invalid = (message: string, path: string): Refusal => ({
          code: 'DEF_FLOW_TARGET_INVALID',
          message,
          paths: [`params.target${path}`],
        });
        let found: TargetSurface | Refusal;
        if (where.sheetId !== undefined && where.entityId === undefined) {
          const sheet = doc.entities[where.sheetId];
          if (sheet?.kind !== 'nurbs_surface')
            return invalid(
              sheet === undefined ? `sheet '${where.sheetId}' not found` : `'${where.sheetId}' is a ${sheet.kind}, not a nurbs_surface`,
              '.sheetId',
            );
          found = { surface: worldSurface(sheet), side: flipNormal ? -1 : 1 };
        } else if (where.entityId !== undefined && where.faceNear !== undefined && where.sheetId === undefined) {
          found = faceTarget(doc, target.kernel, where.entityId, where.faceNear);
        } else return invalid('give sheetId, or entityId with faceNear (not both)', '');
        if ('code' in found) return found;
        const resolved = resolveTargetFrame(
          target,
          { origin: base.plane.origin, axis: base.plane.normal, reference: base.plane.uDirection },
          'centre',
        );
        if ('code' in resolved) return resolved;
        const { surface, side } = found;
        const origin = closestOnSurface(surface, targetOrigin ?? base.plane.origin);
        const derivatives = surfaceDerivatives(surface, origin.u, origin.v, 1);
        const su = (derivatives[1] as Vec3[])[0] as Vec3;
        const sv = (derivatives[0] as Vec3[])[1] as Vec3;
        const normal = normalize3(cross3(su, sv));
        if (len3(cross3(su, sv)) === 0) return invalid('the target has a degenerate tangent plane at the target origin', '');
        const wanted = targetUDirection ?? base.plane.uDirection;
        const along = (tangent: Vec3): number => dot3(tangent, normalize3(wanted)) / len3(tangent);
        const xAlong = Math.abs(along(su)) >= Math.abs(along(sv)) ? 'u' : 'v';
        const tangentX = xAlong === 'u' ? su : sv;
        const signX = along(tangentX) >= 0 ? 1 : -1;
        const tangentY = cross3(side === 1 ? normal : [-normal[0], -normal[1], -normal[2]], normalize3(tangentX));
        const across = xAlong === 'u' ? sv : su;
        const signY = dot3(across, tangentY) * signX >= 0 ? 1 : -1;
        const { extent } = resolved;
        const tolerance = output?.tolerance ?? defaultTolerance(target.diagonal);
        const law = buildFlowSurface({
          surface,
          origin: [origin.u, origin.v],
          xAlong,
          signX,
          signY,
          normalSign: side,
          xRange: [extent.min[0], extent.max[0]],
          yRange: [extent.min[1], extent.max[1]],
          offset: Math.max(Math.abs(extent.min[2]), Math.abs(extent.max[2])),
          tolerance,
        });
        if (typeof law === 'string')
          return law === 'OVERLAP'
            ? {
                code: 'DEF_FLOW_OVERLAP',
                message:
                  'the body is longer than one closed turn of the target: it would overlap itself; shorten it or use a larger target',
                paths: ['params.base'],
              }
            : law === 'OUTSIDE'
              ? {
                  code: 'DEF_FLOW_OUTSIDE_BASE',
                  message:
                    'the body reaches beyond the edge of the target surface from the target origin: move targetOrigin or shorten the body',
                  paths: ['params.targetOrigin'],
                }
              : invalid('the target surface has a degenerate normal in the wrapped area', '');
        return { law, frame: resolved.frame, extent, defaulted: [] };
      },
    }),
});
