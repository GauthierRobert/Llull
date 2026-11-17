/** quad_remesh — field-aligned quad remeshing of a closed or open mesh, optionally mirror-symmetric, into a subdivision cage or a quad-based mesh (07 MSH FR-MSH-22, M6). */

import { defineCommand, z } from '../schema';
import { levelsField } from '../subdivision/shared';
import type { CommandResult } from '../types';
import { DEFAULT_HARD_EDGE_DEG, DEFAULT_LEVELS, MAX_TARGET_QUADS, MIN_TARGET_QUADS, runQuadRemesh } from './quadRemeshRun';
/**
 * @affects adds 1 subdivision entity (output "subdivision": the quads are the cage, hard edges its creases) or 1 mesh entity (output "mesh": the quads split into triangles); the source stays
 * @invariant only quads; a closed source gives a closed 2-manifold with outward winding; an open source (output "mesh") gives quads whose boundary loops lie on the source's, one for one; with `symmetry` the source must be symmetric about the plane and the quads are exactly mirror-symmetric (the positive half is remeshed, its boundary snapped onto the source's and the plane, then mirrored and welded); the same input and parameters give the same result on the same platform build (the engine is deterministic and has no library-dependent random numbers, but floating-point code generation can differ between compilers and CPUs; provenance.version names the platform); data.deviation is measured on the quad faces, not on the smooth limit surface
 * @failure unknown id / non-solid -> MESH_*; open input with output "subdivision" -> MESH_NOT_CLOSED; non-manifold, inconsistently wound or degenerate input -> MESH_NON_MANIFOLD / MESH_ORIENTATION_INCONSISTENT / MESH_DEGENERATE; a source not symmetric about the plane -> MESH_QUAD_REMESH_NOT_SYMMETRIC; an open source whose boundary loops the engine's quads do not follow one for one (a hole it covers, loops it merges) -> MESH_QUAD_REMESH_BOUNDARY_LOST; a boundary that cannot be snapped onto the rim without folding quads (after retries) -> MESH_QUAD_REMESH_SNAP_FAILED; symmetry with nothing on the positive side of the plane, or triangles lying in it -> MESH_PARAM_INVALID; neither / both targets, target out of range -> MESH_PARAM_INVALID; no native engine -> MESH_ENGINE_UNSUPPORTED; input over the engine cap -> MESH_ENGINE_CAP_EXCEEDED; timeout -> MESH_TIMEOUT; engine failure or an unusable result -> MESH_QUAD_REMESH_FAILED
 */
export const quadRemesh = defineCommand({
  name: 'quad_remesh',
  description:
    'Rebuild a mesh (or the triangles of any 3D solid) as a clean quad mesh whose edge flow follows the surface (QuadriFlow, ' +
    'Huang et al., SGP 2018: orientation field, position field, integer-grid map; nearly all vertices have 4 quads around them, a few ' +
    '3 or 5 mark where the flow turns). Give EITHER `targetQuadCount` (6..' +
    `${MAX_TARGET_QUADS}) OR \`targetEdgeLength\` (document units; the count is surface area / length squared); a closed result usually lands within ` +
    '15 % of the count (coarse inputs and tiny targets can be further); an OPEN or SYMMETRIC result is further off: the engine answers 0.7 to 0.85 of it and the boundary row changes the count by a few quads, so the first answer is under or over (measured 0.83 to 1.2); when it is under 0.85 or the boundary cannot be made the command asks the engine again (at 1.15 x and 0.87 x, or for the count that would have given the target) and keeps the closer result: the finished results measured 0.87 to 1.17 of the target (data.attempts and data.engineTargets: the counts sent; data.targetRatio is the exact ratio, check it). `output` "subdivision" (default) creates a subdivision solid whose cage is the ' +
    'quads (levels `levels`, default 2) with the hard edges as creases, ready for edit_subdivision_cage and an exact B-spline solid with the OCC ' +
    'kernel; "mesh" creates a triangle mesh whose triangles are the quads split along the shorter diagonal. `detectHardEdgesDeg` (default 30; 0 = ' +
    'off) aligns quads to edges of the source sharper than that angle and, for "subdivision", makes the cage edges along them creases (a smooth surface gets none). `adaptiveSize` > 0 turns on curvature-adaptive ' +
    'quad size (smaller quads where the surface bends; the engine has this one mode, so any value above 0 is the same). The source is kept ' +
    '(it is the target of a later fit). Needs a manifold, consistently wound mesh without degenerate faces (repair_mesh, fill_mesh_holes ' +
    'first). An OPEN mesh (boundary loops) works with output "mesh" only: the quads keep its boundary, the outermost layer of the engine quads is replaced by ONE row of quads whose outer edge lies on the source boundary loop (no staircase: every boundary vertex has two quads but the corners of the rim, which are exact; data.boundaryRow "realigned", boundaryRowQuads, boundaryLayerRemoved, boundaryRowEvenness), or, when that row would fold, the vertices of the engine boundary are moved onto the rim ("snapped"); data.boundaryLoops; data.boundaryMove = how far the new boundary vertices are from the nearest vertex of the engine boundary (they are ON the source boundary, so it is not a deviation from it); output "subdivision" needs a closed mesh. ' +
    '`symmetry` {plane yz|xz|xy through the origin} makes the quads exactly mirror-symmetric: the source must already be symmetric about the plane (within 0.1 % of its diagonal, else MESH_QUAD_REMESH_NOT_SYMMETRIC), the half on the positive side is remeshed with its cut on the plane kept, and the half and its mirror image are welded on the plane (the count is the whole). A very uneven triangulation gives better quads after remesh_mesh. Runs on the native mesh engine (llull-compute); there is no ' +
    'TypeScript fallback. Reports quads, vertices, valence (vertices per number of quads around them), irregularVertices, creases, targetRatio and ' +
    'the symmetric deviation of the quad faces from the source (document units; for "subdivision" the smooth limit surface lies inside the cage ' +
    'and is NOT what is measured). Reference: an icosphere of radius 10 with targetQuadCount 600 (l4 icosphere, 5120 triangles) gave 614 quads, eight valence-3 vertices and ' +
    'all others valence 4. Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_NOT_CLOSED (open input with output "subdivision"), MESH_QUAD_REMESH_NOT_SYMMETRIC, MESH_QUAD_REMESH_BOUNDARY_LOST (the engine kept fewer boundary loops than the source has: a mesh with holes, an annulus; close the holes with fill_mesh_holes or cut the mesh along its holes), MESH_QUAD_REMESH_SNAP_FAILED (the boundary loops are there but cannot be placed on the rim without folding quads, after retries at 1.15 x and 0.87 x the count: try another targetQuadCount), ' +
    'MESH_NON_MANIFOLD, MESH_ORIENTATION_INCONSISTENT, MESH_DEGENERATE, MESH_PARAM_INVALID, MESH_ENGINE_UNSUPPORTED, MESH_ENGINE_CAP_EXCEEDED (input over 500000 triangles: decimate_mesh first), MESH_TIMEOUT (LLULL_MESH_OP_TIMEOUT_S), MESH_QUAD_REMESH_FAILED.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to quad-remesh; open meshes need output "mesh".'),
    targetQuadCount: z
      .number()
      .int()
      .min(MIN_TARGET_QUADS)
      .max(MAX_TARGET_QUADS)
      .optional()
      .describe(`Wanted number of quads, ${MIN_TARGET_QUADS}..${MAX_TARGET_QUADS}. Not with targetEdgeLength.`),
    targetEdgeLength: z
      .number()
      .positive()
      .optional()
      .describe('Wanted quad edge length (document units); the quad count is surface area / length squared. Not with targetQuadCount.'),
    adaptiveSize: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        '0 (default): uniform quad size. Above 0: smaller quads where the surface curves more (one mode, any value above 0 is the same).',
      ),
    detectHardEdgesDeg: z
      .number()
      .min(0)
      .max(180)
      .optional()
      .describe(
        `Edges of the source whose faces meet at more than this angle (degrees) are hard: the quads align to them and, for output "subdivision", the cage edges along them become creases. 0 turns it off. Default ${DEFAULT_HARD_EDGE_DEG}.`,
      ),
    output: z
      .enum(['subdivision', 'mesh'])
      .optional()
      .describe(
        '"subdivision" (default): a subdivision solid with the quads as its cage. "mesh": a triangle mesh (each quad split in two).',
      ),
    symmetry: z
      .object({ plane: z.enum(['yz', 'xz', 'xy']).describe('Mirror plane through the origin: yz mirrors x, xz mirrors y, xy mirrors z.') })
      .optional()
      .describe(
        'Make the quads exactly symmetric about this plane. The source must be symmetric about it already (MESH_QUAD_REMESH_NOT_SYMMETRIC otherwise).',
      ),
    levels: levelsField
      .optional()
      .describe(
        `output "subdivision" only: subdivision levels of the new solid, 0..4 (default ${DEFAULT_LEVELS}; each level quadruples the faces).`,
      ),
  }),
  run: (doc, params, ctx): CommandResult => runQuadRemesh(doc, ctx, params),
});
