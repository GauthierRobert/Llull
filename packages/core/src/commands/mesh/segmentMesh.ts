/** segment_mesh — split a mesh into smooth regions and fit each with a plane, cylinder, cone or sphere (07 MSH FR-MSH-20). Read-only. */

import type { MeshData, CadDocument } from '../../model/types';
import type { MeshProvenance } from '../../geometry/mesh/engineTypes';
import { PRIMITIVE_KINDS, type PrimitiveKind } from '../../geometry/mesh/primitiveFit';
import type { Segmentation } from '../../geometry/mesh/segment';
import { resolveMeshEngine } from '../../geometry/mesh/engine';
import { meshDiagonal } from '../../geometry/mesh/weld';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import type { CommandResult, ExecutionContext } from '../types';
import {
  contextOf,
  engineOutcome,
  isCommandResult,
  isLoadFailure,
  loadSolidMesh,
  meshRejection,
  namedDefault,
  withConventions,
} from './meshCommon';

/** Fit tolerance as a fraction of the bounding-box diagonal (named default). */
const TOLERANCE_FRACTION = 0.001;
const DEFAULT_FEATURE_ANGLE_DEG = 30;

/** Segment `mesh` through the installed engines; the engine's refusal (a coded rejection) or the segmentation with its provenance. */
export function runSegmentation(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  command: string,
  id: string,
  mesh: MeshData,
  params: { featureAngleDeg: number; fitTolerance: number; kinds: PrimitiveKind[] },
): { segmentation: Segmentation; provenance: MeshProvenance } | CommandResult {
  const engine = resolveMeshEngine(contextOf(ctx).meshProcessing);
  const outcome = engineOutcome(
    doc,
    command,
    engine.run(
      { mesh },
      { op: 'segment', featureAngleRad: (params.featureAngleDeg * Math.PI) / 180, fitTolerance: params.fitTolerance, kinds: params.kinds },
    ),
    [id],
  );
  if (isCommandResult(outcome)) return outcome;
  if (outcome.segmentation === undefined || outcome.segmentation.groups.length === 0)
    return meshRejection(doc, command, 'MESH_SEGMENT_NO_GROUPS', 'the mesh has no non-degenerate face to segment', [id]);
  return { segmentation: outcome.segmentation, provenance: outcome.provenance };
}

/**
 * @affects none (read-only); data = { groups [{ id, faces, area, fit }], adjacency [{ a, b, edges, length }], fitSummary, unassignedFaces }
 * @invariant a region is a set of faces joined across edges whose dihedral angle is at most featureAngleDeg; its fit is the plane if within tolerance, else the lowest-BIC primitive within it, else freeform
 * @failure unknown id / non-solid -> MESH_*; non-manifold, inconsistently wound or degenerate input -> MESH_NON_MANIFOLD / MESH_ORIENTATION_INCONSISTENT / MESH_DEGENERATE; torus is not built
 */
export const segmentMesh = defineCommand({
  name: 'segment_mesh',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Segment a mesh (or the triangles of any 3D solid) into regions and fit each one with the analytic surface it follows: "plane", ' +
    '"cylinder" (axis, radius), "cone" (apex, axis, half angle), "sphere" (centre, radius) or "freeform" when none is within `fitTolerance`. ' +
    'A region is a set of faces joined across edges whose dihedral angle is at most `featureAngleDeg`, so a tessellated hole wall is ONE ' +
    'cylinder while the sharp edges around it separate it from the planes (a plate with a hole gives 6 planes and 1 cylinder). The fit of a ' +
    'region is the plane when every vertex is within `fitTolerance` of it, else the primitive with the lowest Bayesian information ' +
    'criterion among those within the tolerance (least squares + Levenberg-Marquardt on the region vertices), else freeform with the residual of ' +
    'the best attempt. Reports per group the face count, area (document units^2) and fit with rms and max residual (document units), the ' +
    'adjacency of the regions (shared edges and length) and the count by type. Next: mesh_to_brep (faceted or prismatic) turns the groups into ' +
    'B-rep faces. Needs a manifold, consistently wound mesh without degenerate faces (repair_mesh first). The torus is not fitted. ' +
    'Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_NON_MANIFOLD, MESH_ORIENTATION_INCONSISTENT, MESH_DEGENERATE, MESH_ENGINE_CAP_EXCEEDED.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to segment.'),
    featureAngleDeg: z
      .number()
      .gt(0)
      .lt(180)
      .optional()
      .describe(`Edges whose faces meet at more than this angle (degrees) separate regions. Default ${DEFAULT_FEATURE_ANGLE_DEG}.`),
    fitTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest distance (document units) of a region vertex to its primitive. Default 0.001 x bounding-box diagonal (named default).',
      ),
    kinds: z
      .array(z.enum(['plane', 'cylinder', 'cone', 'sphere']))
      .min(1)
      .optional()
      .describe('Primitives to try. Default all four (the torus is not fitted).'),
    maxListed: z.number().int().min(0).optional().describe('Longest group / adjacency list returned; totals are exact. Default 50.'),
  }),
  run: (doc, { id, featureAngleDeg, fitTolerance, kinds, maxListed }, ctx): CommandResult => {
    const loaded = loadSolidMesh(doc, id, undefined, contextOf(ctx).meshAssets);
    if (isLoadFailure(loaded)) return meshRejection(doc, 'segment_mesh', loaded.code, loaded.message, loaded.ids);
    const tolerance = fitTolerance ?? TOLERANCE_FRACTION * meshDiagonal(loaded.mesh.positions);
    const angle = featureAngleDeg ?? DEFAULT_FEATURE_ANGLE_DEG;
    const wanted: PrimitiveKind[] = kinds === undefined ? [...PRIMITIVE_KINDS] : [...new Set(kinds)];
    const segmented = runSegmentation(doc, ctx, 'segment_mesh', id, loaded.mesh, {
      featureAngleDeg: angle,
      fitTolerance: tolerance,
      kinds: wanted,
    });
    if ('document' in segmented) return segmented;
    const { segmentation, provenance } = segmented;
    const limit = maxListed ?? 50;
    const groups = segmentation.groups.map((group) => ({
      id: `seg-${group.index}`,
      faces: group.faces.length,
      area: group.area,
      fit: group.fit,
    }));
    const summary: Record<string, number> = {};
    for (const group of groups) summary[group.fit.type] = (summary[group.fit.type] ?? 0) + 1;
    const data = withConventions(
      doc,
      {
        id,
        groupCount: groups.length,
        groups: groups.slice(0, limit),
        adjacencyCount: segmentation.adjacency.length,
        adjacency: segmentation.adjacency
          .slice(0, limit)
          .map((pair) => ({ a: `seg-${pair.a}`, b: `seg-${pair.b}`, edges: pair.edges, length: pair.length })),
        fitSummary: summary,
        unassignedFaces: segmentation.unassignedFaces,
        featureAngleDeg: angle,
        fitTolerance: tolerance,
      },
      {
        unverified: loaded.unverified,
        provenance,
        defaults: [
          ...(fitTolerance === undefined
            ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull default 0.001 x bbox diagonal')]
            : []),
          ...(featureAngleDeg === undefined ? [namedDefault('featureAngleDeg', angle, 'deg', 'llull default')] : []),
        ],
      },
    );
    const text = Object.entries(summary)
      .map(([type, count]) => `${count} ${type}`)
      .join(', ');
    return report(
      doc,
      `segment_mesh '${id}': ${groups.length} region(s): ${text} (feature angle ${angle} deg, tolerance ${tolerance.toPrecision(4)} ${doc.units}).`,
      data,
    );
  },
});
