/** shrinkwrap_mesh — project the vertices of a mesh onto another mesh (07 MSH FR-MSH-38). */

import { SHRINKWRAP_MODES, SHRINKWRAP_SIDES } from '../../geometry/mesh/wrapDisplace';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { keepSourceParam } from './levelSetCommands';
import { contextOf, isLoadFailure, loadSolidMesh, meshRejection } from './meshCommon';
import { runMeshOp } from './runMeshOp';

/**
 * @affects rewrites the mesh `id` with moved vertices and the same triangles (or adds one mesh with keepSource); the target is not changed
 * @invariant connectivity is unchanged; a vertex that finds nothing (farther than maxDistance, or no hit along its ray) stays and is counted in data.missed; with offset 0 every moved vertex lies on the target surface (data.residual)
 * @failure unknown id / targetId or non-solid -> MESH_*; targetId equal to id, mode direction without a direction, a direction without length -> MESH_PARAM_INVALID; a source or target over 200,000 triangles without llull-compute, over 4,000,000 with it -> MESH_ENGINE_CAP_EXCEEDED
 */
export const shrinkwrapMesh = defineCommand({
  name: 'shrinkwrap_mesh',
  description:
    'Shrink-wrap a mesh (or the triangles of any 3D solid) `id` onto another mesh or solid `targetId`: every vertex moves onto the target surface, ' +
    'connectivity unchanged. mode "nearest" (default) moves a vertex to the closest point of the target; "normal" casts a ray along the vertex normal ' +
    'and "direction" along the fixed `direction` vector (both ways; the nearest hit wins) and moves the vertex to that hit, or leaves it when the ray ' +
    'misses. `offset` (document units, default 0) keeps that distance from the target surface along the target face normal at the hit, on the `side` ' +
    '"keep" (default: the side the vertex was on), "outside" (the face-normal side) or "inside". `maxDistance` leaves vertices farther than it in place ' +
    '(nearest: farther from the target; rays: no hit within that distance). Reports data.moved, missed (vertices left in place), maxMove, meanMove ' +
    '(document units) and residual (largest |distance of the result to the target - offset|, 0 on the surface for offset 0) and the symmetric deviation of the result from the ' +
    'source. Reads the full-resolution target and source (never a level of detail). Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_ENGINE_CAP_EXCEEDED ' +
    '(the TypeScript engine handles up to 200000 triangles in each mesh, the native llull-compute engine up to 4000000; decimate_mesh first), MESH_ASSET_MISSING / MESH_ASSET_UNAVAILABLE.',
  annotations: { readsMeshTriangles: true },
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) whose vertices move.'),
    targetId: z.string().describe('Id of the mesh (or other 3D solid) to wrap onto; it is not changed. Not `id`.'),
    mode: z
      .enum(SHRINKWRAP_MODES)
      .optional()
      .describe(
        '"nearest" (default) closest point of the target; "normal" first hit along the vertex normal; "direction" first hit along `direction`.',
      ),
    direction: vec3('Projection direction [x, y, z] (world, any length) for mode "direction".').optional(),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe('Distance kept from the target surface along its face normal (document units, default 0).'),
    side: z
      .enum(SHRINKWRAP_SIDES)
      .optional()
      .describe('Side of the target the offset is on: "keep" (default, where the vertex was), "outside" (face-normal side) or "inside".'),
    maxDistance: z
      .number()
      .positive()
      .optional()
      .describe('Vertices (or rays) farther than this from the target stay where they are (document units). Default unlimited.'),
    keepSource: keepSourceParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, targetId, mode, direction, offset, side, maxDistance, keepSource } = params;
    const chosen = mode ?? 'nearest';
    const refuse = (message: string, path: string): CommandResult =>
      meshRejection(doc, 'shrinkwrap_mesh', 'MESH_PARAM_INVALID', message, [id], [path]);
    if (targetId === id) return refuse('the target must be another entity than the one that is wrapped', 'targetId');
    if (chosen === 'direction' && direction === undefined) return refuse('mode "direction" needs `direction`', 'direction');
    if (chosen === 'direction' && direction !== undefined && Math.hypot(direction[0], direction[1], direction[2]) === 0)
      return refuse('`direction` has no length', 'direction');
    const target = loadSolidMesh(doc, targetId, undefined, contextOf(ctx).meshAssets);
    if (isLoadFailure(target)) return meshRejection(doc, 'shrinkwrap_mesh', target.code, target.message, [id, ...target.ids], ['targetId']);
    return runMeshOp(doc, ctx, {
      command: 'shrinkwrap_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: false,
      deviation: true,
      op: () => ({
        op: 'shrinkwrap',
        target: { mesh: target.mesh },
        mode: chosen,
        offset: offset ?? 0,
        side: side ?? 'keep',
        ...(direction !== undefined && chosen === 'direction' ? { direction } : {}),
        ...(maxDistance !== undefined ? { maxDistance } : {}),
      }),
      fields: (_before, _after, result) => ({ targetId, mode: chosen, offset: offset ?? 0, side: side ?? 'keep', ...result.report }),
      summary: (from, to, _before, _after, unit, result) =>
        `shrinkwrap_mesh '${from}' onto '${targetId}' (${chosen}) -> '${to}': ${String(result.report['moved'])} vertices moved, ${String(result.report['missed'])} missed, ` +
        `max move ${(result.report['maxMove'] as number).toPrecision(5)} ${unit}, residual ${(result.report['residual'] as number).toExponential(2)} ${unit}.`,
    });
  },
});
