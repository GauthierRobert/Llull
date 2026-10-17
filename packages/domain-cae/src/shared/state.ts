/** Lifecycle state of an analysis case's recorded artifacts, from the input hashes (05 TR-FEA-06). */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '../hash/inputHash';

/**
 * unmeshed (no mesh recorded) | missing (a summary was recorded without its artifact, or the artifact is not on this machine) | stale (a
 * recorded artifact's input hash is not the current one) | meshed | solved | untrusted (a recorded summary differs from the one recomputed
 * from its artifact: only `trustedRecord` yields the last two kinds of verdict that need an artifact).
 */
export type AnalysisState = 'unmeshed' | 'meshed' | 'solved' | 'stale' | 'missing' | 'untrusted';

/**
 * State from the hashes alone (no artifact is read, so `solved` here still has to pass `trustedRecord` before any number is shown).
 * @invariant a summary flagged `verified: false` is `missing`, whatever its hashes say
 */
export function stateOf(doc: CadDocument, analysisCase: AnalysisCase): AnalysisState {
  const mesh = analysisCase.meshSummary;
  if (mesh === undefined) return 'unmeshed';
  if (mesh.verified === false) return 'missing';
  if (mesh.inputHash !== analysisInputHash(doc, analysisCase.id, 'mesh')) return 'stale';
  const results = analysisCase.results;
  if (results === undefined) return 'meshed';
  if (results.verified === false) return 'missing';
  return results.inputHash === analysisInputHash(doc, analysisCase.id, 'full') ? 'solved' : 'stale';
}
