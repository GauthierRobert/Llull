/** Access to the recorded results of a heat_* analysis for the queries that need more than the stored summary (PHY-03 FR-THM-15). */

import type { FeMeshArtifact, FeResultsArtifact, FeArtifactPort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { trustedRecord } from '../shared/trust';
import { problem, type Problem, type ThermalCase } from './access';

export interface ResultArtifacts {
  readonly resultsHash: string;
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
}

/**
 * Current results of the case with their artifacts, the recorded summary re-verified against them (`trustedRecord`).
 * @failure no recorded results -> FEA_RESULTS_MISSING; inputs changed since the solve -> FEA_RESULTS_STALE; no artifact port, or the results /
 *   mesh artifact is not in the store, or the summary was recorded without it -> FEA_RESULTS_MISSING; summary that differs from its
 *   artifact -> FEA_SUMMARY_MISMATCH
 */
export function resultArtifacts(doc: CadDocument, found: ThermalCase, port: FeArtifactPort | null | undefined): ResultArtifacts | Problem {
  const { analysisCase } = found;
  const id = analysisCase.id;
  const record = analysisCase.results;
  if (record === undefined || record.thermal === undefined)
    return problem('FEA_RESULTS_MISSING', `analysis '${id}' has no recorded thermal results`, [id]);
  const trust = trustedRecord(doc, analysisCase, port);
  if (trust.state === 'stale')
    return problem(
      'FEA_RESULTS_STALE',
      `the inputs of analysis '${id}' changed after the solve (results ${record.resultsHash.slice(0, 12)})`,
      [id],
    );
  if (trust.state === 'untrusted')
    return problem('FEA_SUMMARY_MISMATCH', trust.problem?.message ?? 'a recorded summary differs from its artifact', [id]);
  if (trust.results === null || trust.resultsArtifact === null || trust.meshArtifact === null)
    return problem(
      'FEA_RESULTS_MISSING',
      `the results artifact ${record.resultsHash.slice(0, 12)} is not verifiable on this machine: ${trust.problem?.message ?? 'no artifact store'}`,
      [id],
    );
  return { resultsHash: record.resultsHash, mesh: trust.meshArtifact, results: trust.resultsArtifact };
}
