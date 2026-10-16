/** Access to the recorded results of a heat_* analysis for the queries that need more than the stored summary (PHY-03 FR-THM-15). */

import type { FeMeshArtifact, FeResultsArtifact, FeArtifactPort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { stateOf } from '../shared/state';
import { problem, type Problem, type ThermalCase } from './access';

export interface ResultArtifacts {
  readonly resultsHash: string;
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
}

/**
 * Current results of the case with their artifacts.
 * @failure no recorded results -> FEA_RESULTS_MISSING; inputs changed since the solve -> FEA_RESULTS_STALE; no artifact port, or the results /
 *   mesh artifact is not in the store -> FEA_RESULTS_MISSING
 */
export function resultArtifacts(doc: CadDocument, found: ThermalCase, port: FeArtifactPort | null | undefined): ResultArtifacts | Problem {
  const { analysisCase } = found;
  const id = analysisCase.id;
  const record = analysisCase.results;
  if (record === undefined || record.thermal === undefined)
    return problem('FEA_RESULTS_MISSING', `analysis '${id}' has no recorded thermal results`, [id]);
  if (stateOf(doc, analysisCase) === 'stale')
    return problem(
      'FEA_RESULTS_STALE',
      `the inputs of analysis '${id}' changed after the solve (results ${record.resultsHash.slice(0, 12)})`,
      [id],
    );
  const results = port?.get(record.resultsHash) ?? null;
  if (results === null || results.kind !== 'fe_results')
    return problem(
      'FEA_RESULTS_MISSING',
      `the results artifact ${record.resultsHash.slice(0, 12)} is not in the artifact store of this machine`,
      [id],
    );
  const mesh = port?.get(results.meshHash) ?? null;
  if (mesh === null || mesh.kind !== 'fe_mesh')
    return problem(
      'FEA_RESULTS_MISSING',
      `the mesh artifact ${results.meshHash.slice(0, 12)} is not in the artifact store of this machine`,
      [id],
    );
  return { resultsHash: record.resultsHash, mesh, results };
}
