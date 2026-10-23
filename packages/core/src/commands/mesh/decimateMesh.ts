/** decimate_mesh — quadric-error edge-collapse simplification with a triangle target and / or a deviation bound (07 MSH FR-MSH-08). */

import type { DecimateReport } from '../../geometry/mesh/decimate';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { keepSourceParam } from './levelSetCommands';
import { runMeshOp } from './runMeshOp';

/**
 * @affects rewrites the mesh `id` with fewer triangles (or adds one mesh with keepSource)
 * @invariant no fold-over, no new non-manifold edge, no face of vanishing area; with maxDeviation every original vertex and face centroid stays within it of the result and every result vertex / face centroid within it of the original (re-measured in data.deviation)
 * @failure unknown id / non-solid -> MESH_*; non-manifold, inconsistently wound or degenerate input -> MESH_NON_MANIFOLD / MESH_ORIENTATION_INCONSISTENT / MESH_DEGENERATE; no stop rule -> MESH_PARAM_INVALID; requireTarget and the target not reached -> MESH_TARGET_UNREACHABLE
 */
export const decimateMesh = defineCommand({
  name: 'decimate_mesh',
  description:
    'Reduce the triangle count of a mesh (or the triangles of any 3D solid) by quadric-error edge collapse (Garland-Heckbert 1997). Give a stop ' +
    'rule: `targetTriangles`, or `ratio` (fraction of the triangles to keep, 0..1), and / or `maxDeviation` (document units): collapses that would ' +
    'move the surface farther than this from the original, in either direction, are rejected, so the result stays within it (re-measured and ' +
    'returned as data.deviation {forwardMax, backwardMax, hausdorff, mean, rms}). With only a target the quadric error decides what is lost: flat ' +
    'regions collapse first at zero cost. Boundary vertices are locked unless preserveBoundary is false (then a penalty keeps the boundary ' +
    'shape); preserveFeatureAngleDeg keeps edges sharper than that angle; lockedRegion freezes every vertex inside a sphere. When the ' +
    'deviation bound or the locked boundary stops the reduction first, the result is still applied and data.reachedTarget is false with a ' +
    'warning MESH_TARGET_UNREACHABLE; requireTarget true refuses instead. Needs a manifold, consistently wound mesh without degenerate faces ' +
    '(repair_mesh first). Reports trianglesBefore / trianglesAfter, collapses and the rejections by reason. Lengths in document units. ' +
    'Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_NON_MANIFOLD, MESH_ORIENTATION_INCONSISTENT, MESH_DEGENERATE, MESH_TARGET_UNREACHABLE.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to decimate.'),
    targetTriangles: z.number().int().positive().optional().describe('Stop when the mesh has at most this many triangles.'),
    ratio: z
      .number()
      .gt(0)
      .lt(1)
      .optional()
      .describe('Stop at this fraction of the current triangle count (0..1, exclusive). Not with targetTriangles.'),
    maxDeviation: z
      .number()
      .positive()
      .optional()
      .describe('Largest allowed distance (document units) between the result and the original surface, both directions.'),
    preserveBoundary: z
      .boolean()
      .optional()
      .describe('true (default): boundary vertices of open meshes stay. false: they may collapse along the boundary under a penalty.'),
    preserveFeatureAngleDeg: z
      .number()
      .min(0)
      .max(180)
      .optional()
      .describe(
        'Edges whose faces meet at more than this angle (degrees) are penalised so sharp features survive. Default: no feature protection.',
      ),
    lockedRegion: z
      .object({
        center: vec3('Centre [x, y, z] of the locked sphere (document units, world).'),
        radius: z.number().positive().describe('Radius of the locked sphere (document units).'),
      })
      .optional()
      .describe('Vertices inside this sphere never move or disappear.'),
    requireTarget: z
      .boolean()
      .optional()
      .describe('true: refuse with MESH_TARGET_UNREACHABLE when the target is not reached. Default false (warn and apply).'),
    keepSource: keepSourceParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, targetTriangles, ratio, maxDeviation, preserveBoundary, preserveFeatureAngleDeg, lockedRegion, requireTarget, keepSource } =
      params;
    return runMeshOp(doc, ctx, {
      command: 'decimate_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: false,
      deviation: true,
      precheck: (_, before) => {
        if (targetTriangles === undefined && ratio === undefined && maxDeviation === undefined)
          return { code: 'MESH_PARAM_INVALID', message: 'give targetTriangles, ratio or maxDeviation', path: 'targetTriangles' };
        if (targetTriangles !== undefined && ratio !== undefined)
          return { code: 'MESH_PARAM_INVALID', message: 'give targetTriangles or ratio, not both', path: 'ratio' };
        const target = targetTriangles ?? (ratio === undefined ? undefined : Math.ceil(ratio * before.faces));
        if (target !== undefined && target >= before.faces && maxDeviation === undefined)
          return {
            code: 'MESH_PARAM_INVALID',
            message: `the mesh already has ${before.faces} triangles, not more than the target ${target}`,
            path: 'targetTriangles',
          };
        return null;
      },
      op: (_, before) => {
        const target = targetTriangles ?? (ratio === undefined ? undefined : Math.max(1, Math.ceil(ratio * before.faces)));
        return {
          op: 'decimate',
          preserveBoundary: preserveBoundary ?? true,
          ...(target !== undefined ? { targetTriangles: target } : {}),
          ...(maxDeviation !== undefined ? { maxDeviation } : {}),
          ...(preserveFeatureAngleDeg !== undefined ? { featureAngleRad: (preserveFeatureAngleDeg * Math.PI) / 180 } : {}),
          ...(lockedRegion !== undefined ? { lockedRegion: { center: lockedRegion.center, radius: lockedRegion.radius } } : {}),
        };
      },
      accept: (result) =>
        requireTarget === true && (result.report as unknown as DecimateReport).reachedTarget === false
          ? {
              code: 'MESH_TARGET_UNREACHABLE',
              message: `the stop rule halted at ${(result.report as unknown as DecimateReport).trianglesAfter} triangles before the target`,
              path: 'targetTriangles',
            }
          : null,
      fields: (before, _after, result) => {
        const report = result.report as unknown as DecimateReport;
        return {
          trianglesBefore: report.trianglesBefore,
          trianglesAfter: report.trianglesAfter,
          reachedTarget: report.reachedTarget,
          stoppedBy: report.stoppedBy,
          collapses: report.collapses,
          rejected: report.rejected,
          maxCollapseCost: report.maxCollapseCost,
          preserveBoundary: preserveBoundary ?? true,
          volumeBefore: before.volume,
          areaBefore: before.area,
          warnings:
            report.reachedTarget === false
              ? [
                  {
                    code: 'MESH_TARGET_UNREACHABLE',
                    message: `halted at ${report.trianglesAfter} triangles (stop rule: ${report.stoppedBy}); locked boundary, deviation bound or validity checks leave no more collapses`,
                  },
                ]
              : [],
        };
      },
      summary: (from, to, _before, after, unit, result) => {
        const report = result.report as unknown as DecimateReport;
        return (
          `decimate_mesh '${from}' -> '${to}': ${report.trianglesBefore} -> ${after.faces} triangles in ${report.collapses} collapses` +
          `${report.reachedTarget === false ? ' (target NOT reached)' : ''}` +
          `${maxDeviation !== undefined ? `, bound ${maxDeviation} ${unit}` : ''}.`
        );
      },
    });
  },
});
