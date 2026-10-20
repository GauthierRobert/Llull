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
 * @invariant bonding 'separate' (default, stored as absent) or 'conformal'; solids are tets, shell / plane-stress parts tri or quad (elementFamily); order 1 (C3D4) or 2 (C3D10); globalSize > 0; 0 < minSize <= globalSize; every refinement size <= globalSize
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
    elementFamily: z
      .enum(['tet', 'shell_tri', 'shell_quad'])
      .optional()
      .describe(
        'Element shape of shell / plane-stress parts: shell_tri (triangles, S3 / S6, CPS3 / CPS6) or shell_quad (all quadrilaterals by subdivision, ' +
          'S4 / S8, CPS4 / CPS8; needed for composite shells: order 2). Solid parts are always tetrahedra; "tet" (default) meshes 2D parts with triangles.',
      ),
    optimize: z.enum(['default', 'netgen', 'high_order', 'none']).optional().describe('Mesh optimisation pass; default "default".'),
    bonding: z
      .enum(['separate', 'conformal'])
      .optional()
      .describe(
        'How touching parts of a multi-part analysis are meshed. "separate" (default): one independent volume per part, no shared nodes ' +
          '(needed for contact). "conformal": all parts are fragmented in one Gmsh model so touching parts share their interface nodes ' +
          '(bonded / perfectly glued parts; each part keeps its own element set and material). Conformal needs exact STEP geometry ' +
          '(OCC kernel) and parts that only touch (do not overlap: subtract one from the other first); otherwise fea_mesh is refused.',
      ),
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
    const bonding = params.bonding === undefined ? current.bonding : params.bonding === 'conformal' ? 'conformal' : undefined;
    const mesh: MeshControls = {
      mesher: current.mesher,
      elementFamily: params.elementFamily ?? current.elementFamily,
      order: params.order ?? current.order,
      globalSize: params.globalSize ?? current.globalSize,
      refinements,
      optimize: params.optimize ?? current.optimize,
      ...(minSize !== undefined ? { minSize } : {}),
      ...(bonding === 'conformal' ? { bonding } : {}),
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
      `set_mesh_controls: '${params.analysisId}' ${mesh.elementFamily} order ${mesh.order}, globalSize ${mesh.globalSize} ${doc.units}` +
        `${mesh.minSize === undefined ? '' : `, minSize ${mesh.minSize}`}, ${mesh.refinements.length} refinement(s)${mesh.bonding === 'conformal' ? ', conformal bonding' : ''}.`,
      [params.analysisId],
    );
  },
});
