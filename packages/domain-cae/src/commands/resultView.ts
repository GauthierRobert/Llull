/** set_result_view: which field, load case / mode and deformation scale the result view of an analysis shows (presentation data of the case). */

import type { AnalysisCase } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { loadCaseNameProblem } from '../shared/names';
import { analysisIdSchema } from '../shared/schemas';

export const RESULT_VIEW_FIELDS = ['von_mises', 'u_mag', 'u_x', 'u_y', 'u_z', 's_xx', 's_yy', 's_zz', 'mode'] as const;

/**
 * @affects doc.analysis.cases[analysisId].view (presentation only: not part of the analysis input hash, results stay valid)
 * @invariant field `mode` needs a modal / buckling case and a mode >= 1 (default 1); other fields need no mode; deformationScale >= 0 (default 1, 0 = undeformed)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; field / mode mismatch, invalid load case name or scale -> FEA_PARAM_INVALID (unchanged doc)
 */
export const setResultView = defineCommand({
  name: 'set_result_view',
  description:
    'Choose what the result view of an analysis shows: field (von_mises, u_mag, u_x, u_y, u_z, s_xx, s_yy, s_zz, or mode for a modal / buckling case), the ' +
    'load case or the mode number, and the deformation scale (1 = true scale, 0 = undeformed, larger exaggerates; render_fea_results also takes its own ' +
    'deformationScale). It only records the choice on the case (the desktop result panel reads it); it solves nothing and does not make results stale. ' +
    'To read numbers use fea_result_field, to see a picture use render_fea_results.',
  params: z.object({
    analysisId: analysisIdSchema,
    field: z
      .enum(RESULT_VIEW_FIELDS)
      .describe('Field to show: von_mises | u_mag | u_x | u_y | u_z | s_xx | s_yy | s_zz | mode (modal / buckling mode shape).'),
    loadCase: z.string().optional().describe('Load case to show (1-40 letters, digits or underscores). Omit for the first.'),
    mode: z.number().int().min(1).optional().describe('field mode only: mode number, 1-based (default 1).'),
    deformationScale: z.number().optional().describe('Deformed-shape scale factor, a finite number >= 0 (default 1; 0 = undeformed).'),
  }),
  run: (doc, { analysisId, field, loadCase, mode, deformationScale = 1 }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseCode(doc, 'set_result_view', code, message, [analysisId], paths);
    const found = caseOf(doc, analysisId);
    if (found === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, ['analysisId']);
    const eigen = found.type === 'modal' || found.type === 'buckling';
    if (field === 'mode' && !eigen)
      return fail('FEA_PARAM_INVALID', `field 'mode' needs a modal / buckling analysis, not '${found.type}'`, ['field']);
    if (mode !== undefined && field !== 'mode') return fail('FEA_PARAM_INVALID', "mode applies to field 'mode' only", ['mode']);
    if (!(Number.isFinite(deformationScale) && deformationScale >= 0))
      return fail('FEA_PARAM_INVALID', `deformationScale ${deformationScale} must be a finite number >= 0`, ['deformationScale']);
    const caseProblem = loadCase === undefined ? null : loadCaseNameProblem(loadCase);
    if (caseProblem !== null) return fail('FEA_PARAM_INVALID', caseProblem, ['loadCase']);
    const view: NonNullable<AnalysisCase['view']> = {
      field,
      ...(loadCase !== undefined ? { loadCase } : {}),
      ...(field === 'mode' ? { mode: mode ?? 1 } : {}),
      deformationScale,
    };
    return changed(
      withCase(doc, { ...found, view }),
      `set_result_view: '${analysisId}' shows ${field}${field === 'mode' ? ` ${view.mode}` : ''}${loadCase === undefined ? '' : `, load case ${loadCase}`}, deformation x${deformationScale}.`,
      [analysisId],
    );
  },
});
