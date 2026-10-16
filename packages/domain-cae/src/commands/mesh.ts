/** set_mesh_controls: element family / order / sizes of an analysis mesh. */

import type { AnalysisCase, MeshControls } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { analysisIdSchema } from '../shared/schemas';
import { feaTargetSchema, targetProblem, toTarget } from '../shared/target';

/**
 * @affects doc.analysis.cases[analysisId].mesh (given fields replace the current controls; the recorded mesh summary stays and reads as stale)
 * @invariant tet elements only; order 1 (C3D4) or 2 (C3D10); globalSize > 0; 0 < minSize <= globalSize; every refinement size <= globalSize
 *   and its target is a part of the case
 * @failure unknown analysis, non-positive / inconsistent sizes, order not 1|2, bad refinement target -> refusal, unchanged doc
 */
export const setMeshControls = defineCommand({
  name: 'set_mesh_controls',
  description:
    'Set the tetrahedral mesh controls of an analysis (Gmsh): element order (1 = linear C3D4, 2 = quadratic C3D10, default 2; use 2 for ' +
    'stress), globalSize (target element edge length, document units, > 0), optional minSize and refinements (local size at points near ' +
    'faces / edges / vertices of a part, size <= globalSize). Only the given fields change. Lengths are in document units. Changing the ' +
    'mesh makes a recorded mesh and results stale (describe_analysis shows the state); the host re-runs fea_mesh.',
  params: z.object({
    analysisId: analysisIdSchema,
    order: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe('Element order: 1 or 2.'),
    globalSize: z.number().positive().optional().describe('Target element edge length in document units, > 0.'),
    minSize: z.number().positive().optional().describe('Smallest allowed element size in document units, > 0 and <= globalSize.'),
    refinements: z
      .array(
        z.object({
          target: feaTargetSchema.describe('Faces / edges / points to refine (points near them, document units).'),
          size: z.number().positive().describe('Element size at the target, document units, <= globalSize.'),
        }),
      )
      .optional()
      .describe('Replaces the whole refinement list (empty array clears it).'),
    elementFamily: z.enum(['tet']).optional().describe('Only "tet" is built (default).'),
    optimize: z.enum(['default', 'netgen', 'high_order', 'none']).optional().describe('Mesh optimisation pass; default "default".'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (message: string, ids: readonly string[] = [params.analysisId], code = 'FEA_MESH_CONTROLS_INVALID'): CommandResult =>
      refuseCode(doc, 'set_mesh_controls', code, message, ids);
    const analysisCase = caseOf(doc, params.analysisId);
    if (analysisCase === undefined)
      return refuseCode(
        doc,
        'set_mesh_controls',
        'FEA_ANALYSIS_NOT_FOUND',
        `no analysis '${params.analysisId}'`,
        [params.analysisId],
        ['analysisId'],
      );
    const current = analysisCase.mesh;
    const refinements =
      params.refinements === undefined
        ? current.refinements
        : params.refinements.map((r) => ({ target: toTarget(r.target), size: r.size }));
    const minSize = params.minSize ?? current.minSize;
    const mesh: MeshControls = {
      mesher: current.mesher,
      elementFamily: params.elementFamily ?? current.elementFamily,
      order: params.order ?? current.order,
      globalSize: params.globalSize ?? current.globalSize,
      refinements,
      optimize: params.optimize ?? current.optimize,
      ...(minSize !== undefined ? { minSize } : {}),
    };
    if (mesh.minSize !== undefined && mesh.minSize > mesh.globalSize)
      return fail(`minSize ${mesh.minSize} exceeds globalSize ${mesh.globalSize}`);
    const large = mesh.refinements.find((r) => r.size > mesh.globalSize);
    if (large !== undefined)
      return fail(`refinement size ${large.size} exceeds globalSize ${mesh.globalSize}`, [params.analysisId, large.target.entityId]);
    for (const refinement of mesh.refinements) {
      const problem = targetProblem(doc, analysisCase, refinement.target);
      if (problem !== null) return fail(problem.message, [params.analysisId, refinement.target.entityId], problem.code);
    }
    const next: AnalysisCase = { ...analysisCase, mesh };
    return changed(
      withCase(doc, next),
      `set_mesh_controls: '${params.analysisId}' tet order ${mesh.order}, globalSize ${mesh.globalSize} ${doc.units}` +
        `${mesh.minSize === undefined ? '' : `, minSize ${mesh.minSize}`}, ${mesh.refinements.length} refinement(s).`,
      [params.analysisId],
    );
  },
});
