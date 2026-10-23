/** fill_mesh_holes — close boundary loops with a refined, faired patch (Liepa 2003; 07 MSH FR-MSH-06). */

import type { FilledHole, HoleSelect, SkippedHole } from '../../geometry/mesh/holeFill';
import { LIEPA_ALPHA } from '../../geometry/mesh/holeRefine';
import { buildTopology } from '../../geometry/mesh/topology';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { keepSourceParam } from './levelSetCommands';
import { namedDefault } from './meshCommon';
import { runMeshOp } from './runMeshOp';

const DEFAULT_MAX_BOUNDARY_EDGES = 1000;

/**
 * @affects rewrites the mesh `id` with the selected boundary loops closed (or adds one mesh with keepSource); existing vertices and faces are unchanged
 * @invariant the patch is oriented against the boundary edges, so a filled loop becomes interior edges; only vertices inserted by refinement move (fairing)
 * @failure unknown id -> MESH_ENTITY_NOT_FOUND; a bad index / a point with no loop to find -> MESH_HOLE_NOT_FOUND (holes "all" on a mesh without loops succeeds with filled []); an explicitly chosen loop over maxBoundaryEdges -> MESH_HOLE_TOO_LARGE; loop with a repeated vertex -> MESH_HOLE_NON_SIMPLE
 */
export const fillMeshHoles = defineCommand({
  name: 'fill_mesh_holes',
  description:
    'Close holes (boundary loops) of a mesh (or the triangles of any 3D solid) with the method of Liepa (2003): the loop is triangulated by dynamic ' +
    'programming (smallest dihedral angle to the neighbouring faces, then smallest area), the patch is refined to the edge length of its surroundings ' +
    '(centroid insertion with Delaunay edge swaps) and the inserted vertices are faired: fairing "none" keeps the plain triangulation, "tangent" ' +
    'minimises membrane area (flat), "curvature" (default) minimises thin-plate bending (smooth continuation of the surface). The first boundary ' +
    'loop of analyze_mesh is index 0. A patch with no inserted vertex (small holes) is the plain triangulation whatever the fairing; raise ' +
    'refinementFactor (default 1.414) for more patch vertices. Existing vertices never move. Reports per loop the edges, triangles added, ' +
    'vertices inserted and patch area (document units^2), and the loops skipped with their code; closed tells whether the result is watertight. ' +
    'Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_HOLE_NOT_FOUND (explicit holes only), MESH_HOLE_TOO_LARGE, MESH_HOLE_NON_SIMPLE, MESH_HOLE_NO_TRIANGULATION. ' +
    'With holes "all" (default), loops over maxBoundaryEdges or that cannot be triangulated are skipped and listed instead of refused, and a mesh without any loop comes back unchanged with filled [] (totalLoops 0). Next: repair_mesh mode=orient, check_mesh.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to fill.'),
    holes: z
      .union([
        z.literal('all'),
        z.array(z.number().int().min(0)).min(1),
        z
          .array(
            z.object({
              near: vec3('A point [x, y, z] (document units, world) near the hole; the loop with the closest vertex is chosen.'),
            }),
          )
          .min(1),
      ])
      .optional()
      .describe(
        'Which holes: "all" (default), a list of loop indices as numbered by analyze_mesh boundaryLoops (0-based), or a list of {near: [x, y, z]} points naming the closest loop.',
      ),
    maxBoundaryEdges: z
      .number()
      .int()
      .min(3)
      .optional()
      .describe(
        `Largest loop (edges) to fill. Default ${DEFAULT_MAX_BOUNDARY_EDGES}. Loops up to 120 edges use the exact O(n^3) triangulation, larger ones a greedy one.`,
      ),
    fairing: z
      .enum(['none', 'tangent', 'curvature'])
      .optional()
      .describe('"none" plain triangulation, "tangent" membrane, "curvature" thin plate (default).'),
    refine: z.boolean().optional().describe('Insert vertices so the patch matches the surrounding edge length. Default true.'),
    refinementFactor: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe(
        'Liepa density factor alpha (1..10): a patch triangle is split when alpha x (centroid to corner distance) exceeds the local edge length. Default 1.414 (sqrt 2).',
      ),
    keepSource: keepSourceParam,
  }),
  run: (doc, { id, holes, maxBoundaryEdges, fairing, refine, refinementFactor, keepSource }, ctx): CommandResult => {
    const select: HoleSelect =
      holes === undefined || holes === 'all'
        ? 'all'
        : holes.every((h) => typeof h === 'number')
          ? (holes as number[])
          : { near: (holes as Array<{ near: readonly [number, number, number] }>).map((h) => h.near) };
    const chosenFairing = fairing ?? 'curvature';
    const limit = maxBoundaryEdges ?? DEFAULT_MAX_BOUNDARY_EDGES;
    return runMeshOp(doc, ctx, {
      command: 'fill_mesh_holes',
      id,
      keepSource: keepSource ?? false,
      requireClosed: false,
      deviation: true,
      precheck: (loaded) =>
        select !== 'all' && buildTopology(loaded.mesh.positions.length / 3, loaded.mesh.indices).loops.length === 0
          ? {
              code: 'MESH_HOLE_NOT_FOUND',
              message: `entity '${id}' has no boundary loop: it is already closed or non-manifold`,
              path: 'holes',
            }
          : null,
      op: () => ({
        op: 'fill_holes',
        select,
        maxBoundaryEdges: limit,
        fairing: chosenFairing,
        refine: refine ?? true,
        alpha: refinementFactor ?? LIEPA_ALPHA,
      }),
      defaults: () => [
        ...(maxBoundaryEdges === undefined ? [namedDefault('maxBoundaryEdges', limit, 'edges', 'llull default')] : []),
        ...(refinementFactor === undefined ? [namedDefault('refinementFactor', LIEPA_ALPHA, '', 'Liepa 2003: sqrt 2')] : []),
      ],
      fields: (before, _after, result) => ({
        fairing: chosenFairing,
        totalLoops: result.report['totalLoops'],
        filled: result.report['filled'],
        skipped: result.report['skipped'],
        closedBefore: before.closed,
        volumeBefore: before.volume,
        areaBefore: before.area,
      }),
      summary: (from, to, _before, after, unit, result) => {
        const filled = result.report['filled'] as FilledHole[];
        const skipped = result.report['skipped'] as SkippedHole[];
        const triangles = filled.reduce((sum, h) => sum + h.triangles, 0);
        const area = filled.reduce((sum, h) => sum + h.area, 0);
        return (
          `fill_mesh_holes '${from}' -> '${to}': ${filled.length} loop(s) filled (+${triangles} triangles, patch area ${area.toPrecision(8)} ${unit}^2, fairing ${chosenFairing})` +
          `${skipped.length > 0 ? `, ${skipped.length} skipped (${skipped.map((s) => `${s.loop}:${s.code}`).join(', ')})` : ''}; ${after.closed ? 'closed' : 'still OPEN'}.`
        );
      },
    });
  },
});
