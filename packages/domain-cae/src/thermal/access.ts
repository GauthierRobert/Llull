/** Lookup and replacement of the thermal set-up of a heat_* case (pure; every write returns a new document). */

import type { AnalysisCase, ThermalSetup } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { caseOf, withCase } from '../shared/access';

export interface Problem {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}

export const problem = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): Problem => ({
  code,
  message,
  ids,
  paths,
});

export interface ThermalCase {
  readonly analysisCase: AnalysisCase;
  readonly thermal: ThermalSetup;
}

const isHeatType = (type: AnalysisCase['type']): boolean => type === 'heat_steady' || type === 'heat_transient';

/**
 * The heat_* case `analysisId` with its thermal set-up.
 * @failure unknown id -> FEA_ANALYSIS_NOT_FOUND; other analysis type (or a missing set-up) -> THM_CASE_TYPE
 */
export function thermalCaseOf(doc: CadDocument, analysisId: string): ThermalCase | Problem {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return problem('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
  if (!isHeatType(analysisCase.type) || analysisCase.thermal === undefined)
    return problem('THM_CASE_TYPE', `analysis '${analysisId}' is '${analysisCase.type}', not heat_steady / heat_transient`, [analysisId]);
  return { analysisCase, thermal: analysisCase.thermal };
}

export const isProblem = (value: ThermalCase | Problem): value is Problem => 'code' in value;

/** `doc` with the thermal set-up of the case replaced. */
export const withThermal = (doc: CadDocument, found: ThermalCase, thermal: ThermalSetup): CadDocument =>
  withCase(doc, { ...found.analysisCase, thermal });
