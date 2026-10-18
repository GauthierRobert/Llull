/** Read/replace helpers for the `nonlinear` slice of a case (pure). */

import type { AnalysisCase, NonlinearSettings } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { refuseNls } from './codes';

const emptyNonlinear = (): NonlinearSettings => ({
  convergence: { name: 'ccx_default' },
  steps: {},
  stepOrder: [],
  constitutiveSets: {},
  probes: {},
  probeOrder: [],
  outputIncrements: 'all',
});

export const nonlinearOf = (analysis: AnalysisCase): NonlinearSettings => analysis.nonlinear ?? emptyNonlinear();

/** `doc` with the nonlinear settings of `analysis` replaced. */
export const withNonlinear = (doc: CadDocument, analysis: AnalysisCase, nonlinear: NonlinearSettings): CadDocument =>
  withCase(doc, { ...analysis, nonlinear });

/**
 * The nonlinear_static case `analysisId`, or the coded refusal of `command`.
 * @failure unknown id -> FEA_ANALYSIS_NOT_FOUND; other analysis type -> NLS_CASE_NOT_NONLINEAR
 */
export function nonlinearCase(doc: CadDocument, command: string, analysisId: string): { readonly analysis: AnalysisCase } | CommandResult {
  const analysis = caseOf(doc, analysisId);
  if (analysis === undefined)
    return refuseNls(doc, command, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
  if (analysis.type !== 'nonlinear_static')
    return refuseNls(
      doc,
      command,
      'NLS_CASE_NOT_NONLINEAR',
      `analysis '${analysisId}' is of type '${analysis.type}', not nonlinear_static`,
      [analysisId],
      ['analysisId'],
    );
  return { analysis };
}

export const isRefusal = (value: { readonly analysis: AnalysisCase } | CommandResult): value is CommandResult => 'summary' in value;
