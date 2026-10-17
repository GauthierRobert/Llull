/** record_fe_mesh / record_fea_results: store the summary of a host-produced artifact, validated against the artifact store (05 §4.1). */

import type { AnalysisCase, MeshSummary, ResultsSummary } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { analysisInputHash } from '../hash/inputHash';
import { stressUnitName, lengthUnitName } from '../decks/units';
import { meshSummary, resultsSummary } from '../results/summary';
import { caseOf, withCase } from '../shared/access';
import { refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { differingKeys, fetchArtifact } from '../shared/trust';

const summaryNote =
  'Exactly the summary returned by the host transport (never hand-written): it is recomputed from the artifact and compared.';

type SummaryLike = { readonly inputHash?: unknown };

/** `summary` kept as given but flagged `verified: false`; null when it lacks the text `inputHash` every summary carries. */
function unverified<T extends object>(summary: T & SummaryLike): (T & { readonly verified: false }) | null {
  return typeof summary.inputHash === 'string' ? { ...summary, verified: false } : null;
}

function withoutResults(analysisCase: AnalysisCase): AnalysisCase {
  const { results, ...rest } = analysisCase;
  return results === undefined ? analysisCase : rest;
}

/**
 * @affects doc.analysis.cases[analysisId].meshSummary (set); recorded results are cleared
 * @invariant with the artifact available: its sha256 equals the hash, its inputHash is the current mesh input hash and summary equals the
 *   summary recomputed from it (trust model, 05 §4.1); WITHOUT it (no port, not in the store: replay on another machine) the summary is
 *   kept flagged `verified: false` - state `missing`, never read by any query
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; sha256 or summary differs -> FEA_SUMMARY_MISMATCH; artifact built for other inputs ->
 *   (refusal); built for other inputs -> recorded as is, the case reads stale; summary without a text inputHash when the artifact is
 *   unavailable -> FEA_SUMMARY_MISMATCH (all refusals, unchanged doc)
 */
export const recordFeMesh = defineCommand({
  name: 'record_fe_mesh',
  description:
    'Record the summary of a finite-element mesh built by the host (fea_mesh transport) on an analysis. Not for hand use: the summary is ' +
    're-derived from the stored mesh artifact and refused unless it matches exactly, so numbers cannot be invented. Clears recorded results. ' +
    'Refused with FEA_ARTIFACT_NOT_FOUND when the artifact store does not hold the mesh, FEA_SUMMARY_MISMATCH when the summary differs, ' +
    'A mesh built for other inputs (the analysis or geometry changed since, e.g. on regeneration) is recorded STALE, not refused.',
  params: z.object({
    analysisId: analysisIdSchema,
    summary: z.looseObject({ meshHash: z.string().describe('sha256 of the canonical mesh artifact JSON.') }).describe(summaryNote),
  }),
  run: (doc: CadDocument, { analysisId, summary }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId]): CommandResult =>
      refuseFe(doc, 'record_fe_mesh', code, message, ids);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`);
    const fetched = fetchArtifact(ctx?.feaArtifacts, summary.meshHash, 'fe_mesh');
    if ('code' in fetched && fetched.code === 'FEA_ARTIFACT_NOT_FOUND') {
      const flagged = unverified(summary);
      if (flagged === null) return fail('FEA_SUMMARY_MISMATCH', 'the summary has no text inputHash', [analysisId, summary.meshHash]);
      return changed(
        withCase(doc, { ...withoutResults(analysisCase), meshSummary: flagged as unknown as MeshSummary }),
        `record_fe_mesh: '${analysisId}' mesh ${summary.meshHash.slice(0, 12)} recorded UNVERIFIED (artifact not available on this machine): state missing, no number is used until fea_mesh is run here.`,
        [analysisId],
      );
    }
    if ('code' in fetched) return fail(fetched.code, fetched.message, [analysisId, summary.meshHash]);
    const expected = meshSummary(fetched.artifact, summary.meshHash);
    const differing = differingKeys(summary, expected);
    if (differing.length > 0)
      return fail('FEA_SUMMARY_MISMATCH', `the summary differs from the one recomputed from the artifact in: ${differing.join(', ')}`, [
        analysisId,
        summary.meshHash,
      ]);
    if (fetched.artifact.inputHash !== analysisInputHash(doc, analysisId, 'mesh'))
      return changed(
        withCase(doc, { ...withoutResults(analysisCase), meshSummary: expected }),
        `record_fe_mesh: '${analysisId}' mesh ${summary.meshHash.slice(0, 12)} recorded STALE: it was built for other inputs than the current analysis (e.g. the geometry was regenerated); re-run fea_mesh then fea_solve.`,
        [analysisId],
      );
    return changed(
      withCase(doc, { ...withoutResults(analysisCase), meshSummary: expected }),
      `record_fe_mesh: '${analysisId}' meshed — ${expected.nodes} nodes, ${Object.entries(expected.elements)
        .map(([type, count]) => `${count} ${type}`)
        .join(', ')}, ${expected.quality.inverted} inverted (${expected.mesher} ${expected.mesherVersion}).`,
      [analysisId],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].results (set)
 * @invariant as record_fe_mesh for summary.resultsHash (the summary is kept flagged `verified: false` when the results or the recorded mesh
 *   artifact is unavailable); additionally the case has a recorded mesh, the results were computed on exactly that mesh (results.meshHash)
 *   and for the current full input hash; summarised against the recorded mesh artifact
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; sha256 or summary differs -> FEA_SUMMARY_MISMATCH; no recorded mesh or other meshHash ->
 *   FEA_MESH_MISMATCH; other inputs -> recorded as is (the case reads stale; its results are withheld until re-solved)
 */
export const recordFeaResults = defineCommand({
  name: 'record_fea_results',
  description:
    'Record the summary of solver results produced by the host (fea_solve transport) on an analysis that has a recorded mesh. Not for hand ' +
    'use: the summary is re-derived from the stored results artifact and refused unless it matches exactly. Refused with ' +
    'FEA_ARTIFACT_NOT_FOUND (artifact absent), FEA_SUMMARY_MISMATCH, FEA_MESH_MISMATCH (results not computed on the recorded mesh, or no ' +
    'mesh recorded); results computed for other inputs are recorded STALE (re-run fea_mesh then fea_solve).',
  params: z.object({
    analysisId: analysisIdSchema,
    summary: z.looseObject({ resultsHash: z.string().describe('sha256 of the canonical results artifact JSON.') }).describe(summaryNote),
  }),
  run: (doc: CadDocument, { analysisId, summary }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId]): CommandResult =>
      refuseFe(doc, 'record_fea_results', code, message, ids);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`);
    const recordedMesh = analysisCase.meshSummary;
    if (recordedMesh === undefined)
      return fail('FEA_MESH_MISMATCH', `analysis '${analysisId}' has no recorded mesh (record_fe_mesh first)`);
    const keepUnverified = (): CommandResult => {
      const flagged = unverified(summary);
      if (flagged === null) return fail('FEA_SUMMARY_MISMATCH', 'the summary has no text inputHash', [analysisId, summary.resultsHash]);
      return changed(
        withCase(doc, { ...analysisCase, results: flagged as unknown as ResultsSummary }),
        `record_fea_results: '${analysisId}' results ${summary.resultsHash.slice(0, 12)} recorded UNVERIFIED (artifact not available on this machine): state missing, no number is used until fea_solve is run here.`,
        [analysisId],
      );
    };
    const fetched = fetchArtifact(ctx?.feaArtifacts, summary.resultsHash, 'fe_results');
    if ('code' in fetched && fetched.code === 'FEA_ARTIFACT_NOT_FOUND') return keepUnverified();
    if ('code' in fetched) return fail(fetched.code, fetched.message, [analysisId, summary.resultsHash]);
    const results = fetched.artifact;
    if (results.meshHash !== recordedMesh.meshHash)
      return fail(
        'FEA_MESH_MISMATCH',
        `the results were computed on mesh ${results.meshHash}, the recorded mesh is ${recordedMesh.meshHash}`,
        [analysisId, results.meshHash],
      );
    if (results.inputHash !== analysisInputHash(doc, analysisId, 'full'))
      return changed(
        withCase(doc, { ...analysisCase, results: summary as unknown as ResultsSummary }),
        `record_fea_results: '${analysisId}' results ${summary.resultsHash.slice(0, 12)} recorded STALE: they were computed for other inputs than the current analysis (e.g. the geometry was regenerated); re-run fea_mesh then fea_solve.`,
        [analysisId],
      );
    const mesh = fetchArtifact(ctx?.feaArtifacts, recordedMesh.meshHash, 'fe_mesh');
    if ('code' in mesh)
      return mesh.code === 'FEA_ARTIFACT_NOT_FOUND' ? keepUnverified() : fail(mesh.code, mesh.message, [analysisId, recordedMesh.meshHash]);
    const expected = resultsSummary(doc, analysisId, mesh.artifact, results, summary.resultsHash);
    const differing = differingKeys(summary, expected);
    if (differing.length > 0)
      return fail('FEA_SUMMARY_MISMATCH', `the summary differs from the one recomputed from the artifact in: ${differing.join(', ')}`, [
        analysisId,
        summary.resultsHash,
      ]);
    return changed(
      withCase(doc, { ...analysisCase, results: expected }),
      `record_fea_results: '${analysisId}' solved — ${expected.loadCases.length} load case(s)${expected.loadCases
        .map(
          (lc) =>
            `; ${lc.name}: max von Mises ${significantNumber(lc.maxVonMises.value, 6)} ${stressUnitName(expected.units)}, max displacement ${significantNumber(lc.maxDisplacement.value, 6)} ${lengthUnitName(expected.units)}`,
        )
        .join(
          '',
        )}${expected.thermal === undefined ? '' : `; thermal: ${expected.thermal.times.length} time(s)`} (${expected.solver} ${expected.solverVersion}).`,
      [analysisId],
    );
  },
});
