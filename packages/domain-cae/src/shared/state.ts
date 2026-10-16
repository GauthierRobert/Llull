/** Lifecycle state of an analysis case's recorded artifacts, from the input hashes (05 TR-FEA-06). */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '../hash/inputHash';

export type AnalysisState = 'unmeshed' | 'meshed' | 'solved' | 'stale';

/** unmeshed (no mesh recorded) | stale (a recorded artifact's input hash is not the current one) | meshed | solved. */
export function stateOf(doc: CadDocument, analysisCase: AnalysisCase): AnalysisState {
  if (analysisCase.meshSummary === undefined) return 'unmeshed';
  if (analysisCase.meshSummary.inputHash !== analysisInputHash(doc, analysisCase.id, 'mesh')) return 'stale';
  if (analysisCase.results === undefined) return 'meshed';
  return analysisCase.results.inputHash === analysisInputHash(doc, analysisCase.id, 'full') ? 'solved' : 'stale';
}
