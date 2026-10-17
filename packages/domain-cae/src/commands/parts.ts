/** set_part_idealization: declare which solids an analysis meshes. */

import type { AnalysisCase } from '@core/model/analysis';
import { is3D } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { analysisIdSchema } from '../shared/schemas';

/**
 * @affects doc.analysis.cases[analysisId].parts (adds or re-sets one part; affected: [analysisId])
 * @invariant only the solid idealization (tetrahedral continuum) is built; setting an existing part again is a no-change success
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; missing / 2D entity -> FEA_PART_INVALID; plane_stress / shell -> FEA_IDEALIZATION_UNSUPPORTED
 */
export const setPartIdealization = defineCommand({
  name: 'set_part_idealization',
  description:
    'Add a 3D solid to an analysis as a meshed part (idealization "solid": full 3D tetrahedral continuum, the only one built). Constraints, ' +
    'loads, thermal conditions and refinements may only target entities that are parts. The part needs a material (assign_material) before ' +
    'solving. plane_stress and shell are refused as not built.',
  params: z.object({
    analysisId: analysisIdSchema,
    entityId: z.string().describe('Id of the 3D solid entity to analyse (box, cylinder, extrusion, boolean result, mesh solid, ...).'),
    idealization: z
      .enum(['solid', 'plane_stress', 'shell'])
      .optional()
      .describe('Only "solid" is built (default); the others are refused with FEA_IDEALIZATION_UNSUPPORTED.'),
  }),
  run: (doc, { analysisId, entityId, idealization = 'solid' }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[] = []): CommandResult =>
      refuseCode(doc, 'set_part_idealization', code, message, ids, paths);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity === undefined) return fail('FEA_PART_INVALID', `entity '${entityId}' does not exist`, [entityId], ['entityId']);
    if (!is3D(entity))
      return fail('FEA_PART_INVALID', `entity '${entityId}' is 2D (${entity.kind}); parts must be solids`, [entityId], ['entityId']);
    if (idealization !== 'solid')
      return fail('FEA_IDEALIZATION_UNSUPPORTED', `idealization '${idealization}' is not built; use solid`, [entityId], ['idealization']);
    const next: AnalysisCase = { ...analysisCase, parts: { ...analysisCase.parts, [entityId]: { kind: 'solid' } } };
    const count = Object.keys(next.parts).length;
    return changed(
      withCase(doc, next),
      `set_part_idealization: '${entityId}' (${entity.kind}) is a solid part of '${analysisId}' (${count} part${count === 1 ? '' : 's'}).`,
      [analysisId],
    );
  },
});
