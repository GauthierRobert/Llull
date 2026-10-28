/** remesh_mesh — isotropic / adaptive remeshing to a target edge length (Botsch-Kobbelt; 07 MSH FR-MSH-09). */

import type { RemeshReport } from '../../geometry/mesh/remesh';
import { meshDiagonal } from '../../geometry/mesh/weld';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { keepSourceParam } from './levelSetCommands';
import { namedDefault } from './meshCommon';
import { runMeshOp } from './runMeshOp';

const DEFAULT_ITERATIONS = 5;
const DEFAULT_FEATURE_ANGLE_DEG = 40;
/** A target edge above this fraction of the bounding-box diagonal cannot give a usable mesh (Rhino QuadRemesh fails alike). */
const MAX_EDGE_FRACTION = 0.25;

/**
 * @affects rewrites the mesh `id` with a regular triangulation of the same surface (or adds one mesh with keepSource)
 * @invariant after the closing split pass no edge exceeds 4/3 of its target length; never a fold-over or non-manifold edge; feature edges and (preserveBoundary) boundary vertices keep their place; the result is re-measured against the input in data.deviation
 * @failure unknown id / non-solid -> MESH_*; neither / both length modes -> MESH_PARAM_INVALID; target over 0.25 x bbox diagonal -> MESH_REMESH_EDGE_TOO_LARGE; result over 4000000 triangles -> MESH_REMESH_RESULT_TOO_LARGE; input over the engine cap (TypeScript 200000, native 2000000) -> MESH_ENGINE_CAP_EXCEEDED; non-manifold / inconsistently wound / degenerate input -> MESH_NON_MANIFOLD / MESH_ORIENTATION_INCONSISTENT / MESH_DEGENERATE
 */
export const remeshMesh = defineCommand({
  name: 'remesh_mesh',
  description:
    'Remesh a mesh (or the triangles of any 3D solid) into a regular, well-shaped triangulation of the same surface. Give EITHER ' +
    '`targetEdgeLength` (isotropic: every edge aims at that length) OR `minEdge`, `maxEdge` and `approxError` (adaptive: edge length follows the ' +
    'curvature, short where the surface bends, so the chord error stays near approxError). Per iteration (Botsch and Kobbelt 2004): split edges ' +
    'longer than 4/3 of the target, collapse edges shorter than 4/5, flip edges toward valence 6 (4 on constraints), relax vertices tangentially ' +
    'and project them back onto the input surface; a closing pass splits until no edge exceeds 4/3 of the target. Edges where the faces meet ' +
    'at more than preserveFeatureAngleDeg stay as feature lines (vertices slide along them, corners are fixed); boundary vertices are fixed ' +
    'unless preserveBoundary is false; `region` restricts the edit to a sphere. Needs a manifold, consistently wound mesh without degenerate ' +
    'faces (repair_mesh first). Reports data.edgeLength {min, max, mean, p5, p95}, fractionInBand (edges within 4/5..4/3 of the target) and ' +
    'the symmetric deviation from the input (document units). Reference: an icosphere of radius 10 remeshed to 1 gives edges <= 1.3333 and a ' +
    'surface deviation of a few hundredths. Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_REMESH_EDGE_TOO_LARGE, ' +
    'MESH_NON_MANIFOLD, MESH_ORIENTATION_INCONSISTENT, MESH_DEGENERATE, MESH_REMESH_RESULT_TOO_LARGE (the surface would pass 4000000 triangles), ' +
    'MESH_ENGINE_CAP_EXCEEDED (input over 2000000 triangles: decimate_mesh first). Meshes above 200000 triangles run in the native engine.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to remesh.'),
    targetEdgeLength: z
      .number()
      .positive()
      .optional()
      .describe('Isotropic target edge length (document units). Not with minEdge / maxEdge / approxError.'),
    minEdge: z.number().positive().optional().describe('Adaptive: shortest edge (document units), used where curvature is high.'),
    maxEdge: z.number().positive().optional().describe('Adaptive: longest edge (document units), used on flat regions.'),
    approxError: z
      .number()
      .positive()
      .optional()
      .describe(
        'Adaptive: allowed chord error (document units); edge length L = sqrt(6 e / k - 3 e^2) from the local curvature k, clamped to minEdge..maxEdge.',
      ),
    iterations: z.number().int().min(1).max(50).optional().describe(`Remeshing iterations, 1..50. Default ${DEFAULT_ITERATIONS}.`),
    preserveFeatureAngleDeg: z
      .number()
      .min(0)
      .max(180)
      .optional()
      .describe(`Edges between faces turned by more than this (degrees) are kept as feature lines. Default ${DEFAULT_FEATURE_ANGLE_DEG}.`),
    preserveBoundary: z
      .boolean()
      .optional()
      .describe('true (default): boundary vertices of open meshes stay. false: they slide along the boundary.'),
    project: z.boolean().optional().describe('Project vertices back onto the input surface after relaxation. Default true.'),
    region: z
      .object({
        center: vec3('Centre [x, y, z] of the sphere (document units, world).'),
        radius: z.number().positive().describe('Radius of the sphere (document units).'),
      })
      .optional()
      .describe('Only vertices inside this sphere are edited; the rest of the mesh stays as it is.'),
    keepSource: keepSourceParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const {
      id,
      targetEdgeLength,
      minEdge,
      maxEdge,
      approxError,
      iterations,
      preserveFeatureAngleDeg,
      preserveBoundary,
      project,
      region,
      keepSource,
    } = params;
    const adaptive = minEdge !== undefined || maxEdge !== undefined || approxError !== undefined;
    const steps = iterations ?? DEFAULT_ITERATIONS;
    const featureDeg = preserveFeatureAngleDeg ?? DEFAULT_FEATURE_ANGLE_DEG;
    return runMeshOp(doc, ctx, {
      command: 'remesh_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: false,
      deviation: true,
      precheck: (loaded) => {
        if (adaptive === (targetEdgeLength !== undefined))
          return {
            code: 'MESH_PARAM_INVALID',
            message: 'give targetEdgeLength, or minEdge + maxEdge + approxError (not both, not neither)',
            path: 'targetEdgeLength',
          };
        if (adaptive && (minEdge === undefined || maxEdge === undefined || approxError === undefined))
          return {
            code: 'MESH_PARAM_INVALID',
            message: 'adaptive remeshing needs minEdge, maxEdge and approxError together',
            path: 'minEdge',
          };
        if (minEdge !== undefined && maxEdge !== undefined && minEdge > maxEdge)
          return { code: 'MESH_PARAM_INVALID', message: 'minEdge must not exceed maxEdge', path: 'minEdge' };
        const limit = MAX_EDGE_FRACTION * meshDiagonal(loaded.mesh.positions);
        const longest = targetEdgeLength ?? maxEdge ?? 0;
        return longest > limit
          ? {
              code: 'MESH_REMESH_EDGE_TOO_LARGE',
              message: `edge length ${longest} exceeds ${MAX_EDGE_FRACTION} x the bounding-box diagonal (${limit.toPrecision(6)} ${doc.units})`,
              path: targetEdgeLength !== undefined ? 'targetEdgeLength' : 'maxEdge',
            }
          : null;
      },
      op: () => ({
        op: 'remesh',
        iterations: steps,
        featureAngleRad: (featureDeg * Math.PI) / 180,
        preserveBoundary: preserveBoundary ?? true,
        project: project ?? true,
        ...(targetEdgeLength !== undefined ? { targetEdge: targetEdgeLength } : {}),
        ...(minEdge !== undefined ? { minEdge } : {}),
        ...(maxEdge !== undefined ? { maxEdge } : {}),
        ...(approxError !== undefined ? { approxError } : {}),
        ...(region !== undefined ? { region: { center: region.center, radius: region.radius } } : {}),
      }),
      defaults: () => [
        ...(preserveFeatureAngleDeg === undefined ? [namedDefault('preserveFeatureAngleDeg', featureDeg, 'deg', 'llull default')] : []),
        ...(iterations === undefined ? [namedDefault('iterations', steps, '', 'llull default')] : []),
      ],
      fields: (before, _after, result) => {
        const report = result.report as unknown as RemeshReport;
        return {
          mode: report.mode,
          iterations: report.iterations,
          trianglesBefore: report.trianglesBefore,
          trianglesAfter: report.trianglesAfter,
          splits: report.splits,
          collapses: report.collapses,
          flips: report.flips,
          edgeLength: report.edgeLength,
          fractionInBand: report.fractionInBand,
          featureEdges: report.featureEdges,
          ...(targetEdgeLength !== undefined ? { edgeBand: { min: 0.8 * targetEdgeLength, max: (4 / 3) * targetEdgeLength } } : {}),
          volumeBefore: before.volume,
          areaBefore: before.area,
        };
      },
      summary: (from, to, _before, after, unit, result) => {
        const report = result.report as unknown as RemeshReport;
        return (
          `remesh_mesh '${from}' (${report.mode}) -> '${to}': ${report.trianglesBefore} -> ${after.faces} triangles, edges ` +
          `${report.edgeLength.min.toPrecision(4)}..${report.edgeLength.max.toPrecision(4)} ${unit} (mean ${report.edgeLength.mean.toPrecision(4)}, ` +
          `${(report.fractionInBand * 100).toFixed(1)} % in band).`
        );
      },
    });
  },
});
