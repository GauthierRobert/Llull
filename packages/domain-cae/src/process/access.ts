/** The `am_build_distortion` case a PRC command works on, or its coded refusal. */

import type { AnalysisCase } from '@core/model/analysis';
import type { AmBuildSettings } from '@core/model/am';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { caseOf } from '../shared/access';
import { refusePrc } from './codes';

export const isRefusal = <T extends object>(value: T | CommandResult): value is CommandResult => 'summary' in value;

/**
 * The case `analysisId` when it is an am_build_distortion case solved by calculix.
 * @failure unknown case -> FEA_ANALYSIS_NOT_FOUND; other type -> PRC_CASE_TYPE; other solver -> PRC_SOLVER_UNSUPPORTED
 */
export function amCase(doc: CadDocument, command: string, analysisId: string): { readonly analysis: AnalysisCase } | CommandResult {
  const analysis = caseOf(doc, analysisId);
  if (analysis === undefined)
    return refusePrc(doc, command, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
  if (analysis.type !== 'am_build_distortion')
    return refusePrc(
      doc,
      command,
      'PRC_CASE_TYPE',
      `analysis '${analysisId}' is of type '${analysis.type}', not am_build_distortion`,
      [analysisId],
      ['analysisId'],
    );
  if (analysis.solver !== 'calculix')
    return refusePrc(
      doc,
      command,
      'PRC_SOLVER_UNSUPPORTED',
      `am_build_distortion needs solver calculix, the case has '${analysis.solver}'`,
      [analysisId],
      ['analysisId'],
    );
  return { analysis };
}

/** The build set-up of `analysis`, or the PRC_BUILD_SETUP_MISSING refusal. */
export function amSettings(doc: CadDocument, command: string, analysis: AnalysisCase): { readonly am: AmBuildSettings } | CommandResult {
  return analysis.am === undefined
    ? refusePrc(doc, command, 'PRC_BUILD_SETUP_MISSING', `analysis '${analysis.id}' has no build set-up: call am_build_setup first`, [
        analysis.id,
      ])
    : { am: analysis.am };
}
