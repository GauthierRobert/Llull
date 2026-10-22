/** subdivide_mesh — refine a triangle mesh: midpoint (linear), Loop, or smooth (07 MSH M2, FR-MSH-11). */

import { MESH_TRIANGLE_LIMIT } from './meshCommon';
import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { runMeshOp } from './runMeshOp';

const MAX_LEVELS = 6;

/**
 * @affects rewrites the mesh `id` with 4^levels x as many triangles (or adds one mesh with keepSource)
 * @invariant midpoint keeps area and volume exactly; loop is approximating (smooths, shrinks convex shapes); smooth rounds toward the tangent surface
 * @failure unknown id / non-solid -> MESH_*; result over the triangle limit -> MESH_PARAM_INVALID; smooth without Manifold -> MESH_ENGINE_UNSUPPORTED
 */
export const subdivideMesh = defineCommand({
  name: 'subdivide_mesh',
  description:
    'Refine a mesh (or the triangles of any 3D solid) so later operations have enough resolution. method "midpoint" splits every triangle into ' +
    '4 at the edge midpoints and keeps the geometry exactly (area and volume unchanged); "loop" is Loop subdivision (4x the faces, the surface ' +
    'relaxes toward a smooth limit and a convex shape shrinks slightly); "smooth" (Manifold engine) refines toward a curved tangent surface, ' +
    'keeping creases sharper than featureAngleDeg, until edges are shorter than maxEdgeLength or `levels` is reached. Faces x 4 per level ' +
    'for midpoint / loop. Reports faces before / after, area and volume (document units). ' +
    'Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_ENGINE_UNSUPPORTED, MESH_NON_MANIFOLD.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to subdivide.'),
    method: z
      .enum(['midpoint', 'loop', 'smooth'])
      .describe('"midpoint" (linear, exact), "loop" (smoothing) or "smooth" (tangent refinement, Manifold engine).'),
    levels: z.number().int().min(1).max(MAX_LEVELS).optional().describe(`Subdivision passes, 1..${MAX_LEVELS}. Default 1.`),
    maxEdgeLength: z
      .number()
      .positive()
      .optional()
      .describe('method "smooth" only: refine until no edge is longer than this (document units). Default: use `levels`.'),
    featureAngleDeg: z
      .number()
      .min(0)
      .max(180)
      .optional()
      .describe('method "smooth" only: dihedral angles above this stay sharp, in degrees. Default 30.'),
    keepSource: z
      .boolean()
      .optional()
      .describe('true: keep the source and add the result as a new mesh. Default false: the source is rewritten in place.'),
  }),
  run: (doc, { id, method, levels, maxEdgeLength, featureAngleDeg, keepSource }, ctx): CommandResult => {
    const passes = levels ?? 1;
    return runMeshOp(doc, ctx, {
      command: 'subdivide_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: false,
      precheck: (_, before) => {
        // equilateral triangles of edge e have area 0.433 e^2: the face count refineToLength can reach
        const estimate =
          method === 'smooth' && maxEdgeLength !== undefined
            ? Math.max(before.faces, before.area / (0.4330127 * maxEdgeLength ** 2))
            : before.faces * 4 ** passes;
        return estimate > MESH_TRIANGLE_LIMIT
          ? {
              code: 'MESH_PARAM_INVALID',
              message: `about ${Math.round(estimate)} triangles would exceed ${MESH_TRIANGLE_LIMIT}`,
              path: maxEdgeLength !== undefined && method === 'smooth' ? 'maxEdgeLength' : 'levels',
            }
          : null;
      },
      op: () => ({
        op: 'subdivide',
        method,
        levels: passes,
        ...(maxEdgeLength !== undefined ? { maxEdge: maxEdgeLength } : {}),
        featureAngleDeg: featureAngleDeg ?? 30,
      }),
      fields: (before, _after, result) => ({
        method,
        levels: passes,
        facesBefore: before.faces,
        volumeBefore: before.volume,
        areaBefore: before.area,
        ...result.report,
      }),
      summary: (from, to, before, after, unit) =>
        `subdivide_mesh '${from}' ${method} x${passes} -> '${to}': ${before.faces} -> ${after.faces} triangles, area ${after.area.toPrecision(10)} ${unit}^2` +
        `${after.volume !== null ? `, volume ${after.volume.toPrecision(10)} ${unit}^3` : ''}.`,
    });
  },
});
